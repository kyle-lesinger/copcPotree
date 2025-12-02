import * as THREE from 'three'
import * as LazPerfModule from 'laz-perf'
import { applyColormap, Colormap } from './colormaps'

/**
 * Convert TAI time (seconds since 1993-01-01 00:00:00 UTC) to JavaScript Date
 * TAI = International Atomic Time, used by CALIPSO satellite
 */
export function taiToDate(taiSeconds: number): Date {
  // TAI epoch: January 1, 1993, 00:00:00 UTC
  const taiEpoch = new Date('1993-01-01T00:00:00.000Z').getTime() // milliseconds

  // Convert TAI seconds to milliseconds and add to epoch
  const utcMilliseconds = taiEpoch + (taiSeconds * 1000)

  return new Date(utcMilliseconds)
}

/**
 * Format TAI time as readable string
 */
export function formatTaiTime(taiSeconds: number): string {
  const date = taiToDate(taiSeconds)

  // Format as: YYYY-MM-DD HH:MM:SS.sss UTC
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  const seconds = String(date.getUTCSeconds()).padStart(2, '0')
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, '0')

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds} UTC`
}

export interface PointCloudData {
  positions: Float32Array
  colors: Uint8Array
  intensities: Uint16Array
  classifications: Uint8Array
  gpsTimes?: Float64Array // GPS time for temporal filtering/sorting
  count: number // Alias for pointCount
  pointCount?: number // For compatibility with Potree loader
  bounds: {
    min: [number, number, number]
    max: [number, number, number]
  }
  firstPoint?: {
    lon: number
    lat: number
    alt: number
    gpsTime: number
  }
  lastPoint?: {
    lon: number
    lat: number
    alt: number
    gpsTime: number
  }
}

// LAZ header parsing helpers
function readLASHeader(buffer: ArrayBuffer) {
  const view = new DataView(buffer)

  // Read LAS header
  const signature = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  )

  if (signature !== 'LASF') {
    throw new Error('Invalid LAS file - signature mismatch')
  }

  const pointDataOffset = view.getUint32(96, true)
  const pointDataRecordFormat = view.getUint8(104)
  const pointDataRecordLength = view.getUint16(105, true)
  const pointCount = view.getUint32(107, true) ||  view.getUint32(247, true) // Legacy or extended

  const scaleX = view.getFloat64(131, true)
  const scaleY = view.getFloat64(139, true)
  const scaleZ = view.getFloat64(147, true)

  const offsetX = view.getFloat64(155, true)
  const offsetY = view.getFloat64(163, true)
  const offsetZ = view.getFloat64(171, true)

  const maxX = view.getFloat64(179, true)
  const minX = view.getFloat64(187, true)
  const maxY = view.getFloat64(195, true)
  const minY = view.getFloat64(203, true)
  const maxZ = view.getFloat64(211, true)
  const minZ = view.getFloat64(219, true)

  return {
    pointDataOffset,
    pointDataRecordFormat,
    pointDataRecordLength,
    pointCount,
    scale: { x: scaleX, y: scaleY, z: scaleZ },
    offset: { x: offsetX, y: offsetY, z: offsetZ },
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ }
  }
}

// Parse point format 6 (LAS 1.4)
function parsePointFormat6(
  pointBuffer: Uint8Array,
  scale: { x: number, y: number, z: number },
  offset: { x: number, y: number, z: number },
  index: number // Point index for debugging
) {
  const view = new DataView(pointBuffer.buffer, pointBuffer.byteOffset)

  // Point Format 6: X(4) Y(4) Z(4) Intensity(2) Flags(1) Classification(1)
  //                  ScanAngle(2) UserData(1) PointSourceID(2) GPSTime(8)
  //                  Red(2) Green(2) Blue(2) = 30 bytes minimum

  const x = view.getInt32(0, true) * scale.x + offset.x
  const y = view.getInt32(4, true) * scale.y + offset.y
  const z = view.getInt32(8, true) * scale.z + offset.z
  const intensity = view.getUint16(12, true)
  const classification = view.getUint8(15)

  // Try reading GPS time at offset 22 instead of 21
  // Point Source ID is at 19-20 (2 bytes), so next field starts at 21
  // But maybe there's alignment padding?
  let gpsTime = view.getFloat64(22, true)

  // Check if GPS time seems valid (should be positive and reasonable)
  // GPS time in LAS files is typically GPS week seconds (0-604800)
  if (gpsTime < 0 || gpsTime > 1e15 || !isFinite(gpsTime)) {
    // Try offset 21
    gpsTime = view.getFloat64(21, true)

    // If still invalid, try offset 20
    if (gpsTime < 0 || gpsTime > 1e15 || !isFinite(gpsTime)) {
      gpsTime = view.getFloat64(20, true)
    }

    // If all attempts fail, use point index as fallback
    if (gpsTime < 0 || gpsTime > 1e15 || !isFinite(gpsTime)) {
      gpsTime = index // Use point index as sequential time
    }
  }

  return { x, y, z, intensity, classification, gpsTime }
}

/**
 * Load a LAZ/COPC file and extract point cloud data using laz-perf
 * NOTE: This is the simple loader for 2D mode. For 3D with octree optimization, use COPCLODManager.
 */
export async function loadCOPCFile(url: string, onProgress?: (progress: number) => void): Promise<PointCloudData> {
  try {
    console.log(`[copcLoader.ts] Loading LAZ file for 2D mode: ${url}`)

    // Fetch the file
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    console.log(`Fetched ${arrayBuffer.byteLength} bytes`)

    if (onProgress) onProgress(10)

    // Parse LAS header
    const header = readLASHeader(arrayBuffer)
    console.log('LAS Header:', header)
    console.log(`Point format: ${header.pointDataRecordFormat}, Count: ${header.pointCount}`)

    if (onProgress) onProgress(20)

    // Initialize laz-perf WASM module
    console.log('Initializing laz-perf...')
    const createLazPerf = LazPerfModule.createLazPerf || LazPerfModule.create || LazPerfModule.default
    const lazPerf = await createLazPerf({
      locateFile: (path: string) => {
        if (path.endsWith('.wasm')) {
          return '/laz-perf.wasm'
        }
        return path
      }
    })
    console.log('laz-perf initialized')

    if (onProgress) onProgress(30)

    // Allocate memory in WASM heap for the file
    const fileSize = arrayBuffer.byteLength
    const filePtr = lazPerf._malloc(fileSize)
    if (!filePtr) {
      throw new Error('Failed to allocate memory for file')
    }

    // Copy file data to WASM heap
    lazPerf.HEAPU8.set(new Uint8Array(arrayBuffer), filePtr)
    console.log(`Copied file to WASM heap at ${filePtr}`)

    if (onProgress) onProgress(40)

    // Create LASZip decoder
    const laszip = new lazPerf.LASZip()
    laszip.open(filePtr, fileSize)

    const pointCount = laszip.getCount()
    const pointLength = laszip.getPointLength()
    const pointFormat = laszip.getPointFormat()

    console.log(`LASZip opened: ${pointCount} points, format ${pointFormat}, ${pointLength} bytes/point`)

    if (onProgress) onProgress(50)

    // Allocate buffer for a single point
    const pointPtr = lazPerf._malloc(pointLength)
    if (!pointPtr) {
      throw new Error('Failed to allocate memory for point buffer')
    }

    // Arrays to store point data
    const positions: number[] = []
    const intensities: number[] = []
    const classifications: number[] = []
    const gpsTimes: number[] = []

    const bounds = {
      min: [Infinity, Infinity, Infinity] as [number, number, number],
      max: [-Infinity, -Infinity, -Infinity] as [number, number, number]
    }

    // Variables to store first and last point info (will be set after sorting)
    let firstPoint: { lon: number, lat: number, alt: number, gpsTime: number } | undefined
    let lastPoint: { lon: number, lat: number, alt: number, gpsTime: number } | undefined

    // Determine decimation factor for large files
    // Target: reduce to ~5M points for sorting performance
    const TARGET_POINT_COUNT = 5_000_000
    let decimationFactor = 1
    if (pointCount > TARGET_POINT_COUNT) {
      decimationFactor = Math.ceil(pointCount / TARGET_POINT_COUNT)
      console.log(`Large file detected. Decimating by factor of ${decimationFactor} (keeping every ${decimationFactor}th point)`)
      console.log(`Target points: ~${Math.floor(pointCount / decimationFactor).toLocaleString()}`)
    }

    // Read all points (with optional decimation)
    console.log(`Reading ${pointCount} points...`)
    let actualPointsRead = 0
    for (let i = 0; i < pointCount; i++) {
      // Get point from LAZ
      laszip.getPoint(pointPtr)

      // Skip points based on decimation factor
      if (decimationFactor > 1 && i % decimationFactor !== 0) {
        continue
      }

      // Create a view of the point data
      const pointBuffer = new Uint8Array(
        lazPerf.HEAPU8.buffer,
        pointPtr,
        pointLength
      )

      // Parse point
      const point = parsePointFormat6(pointBuffer, header.scale, header.offset, i)

      positions.push(point.x, point.y, point.z)
      intensities.push(point.intensity)
      classifications.push(point.classification)
      gpsTimes.push(point.gpsTime)
      actualPointsRead++

      // Update bounds
      bounds.min[0] = Math.min(bounds.min[0], point.x)
      bounds.min[1] = Math.min(bounds.min[1], point.y)
      bounds.min[2] = Math.min(bounds.min[2], point.z)
      bounds.max[0] = Math.max(bounds.max[0], point.x)
      bounds.max[1] = Math.max(bounds.max[1], point.y)
      bounds.max[2] = Math.max(bounds.max[2], point.z)

      // Report progress every 10000 points
      if (i % 10000 === 0 && onProgress) {
        const progress = 50 + (i / pointCount) * 45
        onProgress(progress)
      }
    }

    console.log(`Read ${actualPointsRead.toLocaleString()} points (${decimationFactor > 1 ? `decimated from ${pointCount.toLocaleString()}` : 'no decimation'})`)

    // Find min/max GPS times without spread operator (avoids stack overflow)
    let minGpsTime = Infinity
    let maxGpsTime = -Infinity
    for (let i = 0; i < gpsTimes.length; i++) {
      minGpsTime = Math.min(minGpsTime, gpsTimes[i])
      maxGpsTime = Math.max(maxGpsTime, gpsTimes[i])
    }

    // Sort points by x,y (lat/lon) position groups, keeping all Z values together
    console.log('Grouping and sorting by x,y positions...')

    // Group points by x,y coordinates (each x,y represents a vertical laser shot)
    interface XYGroup {
      x: number
      y: number
      gpsTime: number
      indices: number[]
    }

    const xyMap = new Map<string, XYGroup>()

    for (let i = 0; i < actualPointsRead; i++) {
      const x = positions[i * 3]
      const y = positions[i * 3 + 1]
      const key = `${x.toFixed(6)},${y.toFixed(6)}`

      if (!xyMap.has(key)) {
        xyMap.set(key, {
          x,
          y,
          gpsTime: gpsTimes[i],
          indices: []
        })
      }
      xyMap.get(key)!.indices.push(i)
    }

    console.log(`Found ${xyMap.size} unique x,y positions`)

    // Sort x,y groups by GPS time
    const sortedGroups = Array.from(xyMap.values()).sort((a, b) => a.gpsTime - b.gpsTime)

    // Reorder all arrays based on sorted x,y groups
    const sortedPositions: number[] = []
    const sortedIntensities: number[] = []
    const sortedClassifications: number[] = []
    const sortedGpsTimes: number[] = []

    for (const group of sortedGroups) {
      // Add all points (all Z values) for this x,y position
      for (const idx of group.indices) {
        sortedPositions.push(positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2])
        sortedIntensities.push(intensities[idx])
        sortedClassifications.push(classifications[idx])
        sortedGpsTimes.push(gpsTimes[idx])
      }
    }

    // Note: We'll use the sorted arrays directly instead of replacing the originals
    // to avoid stack overflow with large arrays

    // Set first and last points (now chronologically ordered)
    firstPoint = {
      lon: sortedPositions[0],
      lat: sortedPositions[1],
      alt: sortedPositions[2],
      gpsTime: sortedGpsTimes[0]
    }

    lastPoint = {
      lon: sortedPositions[(actualPointsRead - 1) * 3],
      lat: sortedPositions[(actualPointsRead - 1) * 3 + 1],
      alt: sortedPositions[(actualPointsRead - 1) * 3 + 2],
      gpsTime: sortedGpsTimes[actualPointsRead - 1]
    }

    if (onProgress) onProgress(95)

    // Cleanup
    lazPerf._free(pointPtr)
    lazPerf._free(filePtr)
    laszip.delete()

    console.log(`Loaded and sorted ${actualPointsRead.toLocaleString()} points`)
    console.log(`Bounds:`, bounds)

    if (onProgress) onProgress(100)

    // Convert sorted arrays to typed arrays
    const positionsArray = new Float32Array(sortedPositions)
    const intensitiesArray = new Uint16Array(sortedIntensities)
    const classificationsArray = new Uint8Array(sortedClassifications)
    const colors = new Uint8Array(actualPointsRead * 3)

    return {
      positions: positionsArray,
      colors,
      intensities: intensitiesArray,
      classifications: classificationsArray,
      gpsTimes: new Float64Array(sortedGpsTimes), // Add GPS times for compatibility
      count: actualPointsRead,
      pointCount: actualPointsRead, // Add for compatibility with Potree interface
      bounds,
      firstPoint,
      lastPoint
    }
  } catch (error) {
    console.error('Error loading LAZ file:', error)
    throw new Error(`Failed to load LAZ file: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Compute colors for points based on elevation
 */
export function computeElevationColors(
  positions: Float32Array,
  colors: Uint8Array,
  minZ: number,
  maxZ: number,
  colormap: Colormap = 'viridis'
) {
  const count = positions.length / 3
  const range = maxZ - minZ

  for (let i = 0; i < count; i++) {
    const z = positions[i * 3 + 2]
    const t = range > 0 ? (z - minZ) / range : 0.5

    const [r, g, b] = applyColormap(t, colormap)

    colors[i * 3] = r
    colors[i * 3 + 1] = g
    colors[i * 3 + 2] = b
  }
}

/**
 * Compute colors for points based on intensity
 *
 * @param useCalipsoScaling - If true, converts LAS intensity values back to physical units
 *                            using CALIPSO encoding: physical = (intensity / 10000) - 0.1
 *                            Then normalizes using physical min/max (default: 0 to 3.5 km⁻¹·sr⁻¹)
 */
export function computeIntensityColors(
  intensities: Uint16Array,
  colors: Uint8Array,
  minIntensity?: number,
  maxIntensity?: number,
  colormap: Colormap = 'viridis',
  useCalipsoScaling: boolean = true
) {
  const count = intensities.length

  // For CALIPSO data, use physical units (km⁻¹·sr⁻¹)
  // LAS encoding: intensity = (physical + 0.1) * 10000
  // Physical decoding: physical = (intensity / 10000) - 0.1
  if (useCalipsoScaling) {
    // Use scientific valid range for CALIPSO backscatter if not specified
    // 532nm valid range: -0.1 to 3.3, we use 0 to 3.5 for normalization
    const physicalMin = minIntensity !== undefined ? minIntensity : 0.0
    const physicalMax = maxIntensity !== undefined ? maxIntensity : 3.5
    const range = physicalMax - physicalMin

    for (let i = 0; i < count; i++) {
      const lasIntensity = intensities[i]

      // Convert LAS intensity back to physical units
      const physical = (lasIntensity / 10000.0) - 0.1

      // Normalize to 0-1 range using physical units
      const normalized = range > 0 ? Math.max(0, Math.min(1, (physical - physicalMin) / range)) : 0.5

      const [r, g, b] = applyColormap(normalized, colormap)

      colors[i * 3] = r
      colors[i * 3 + 1] = g
      colors[i * 3 + 2] = b
    }
  } else {
    // Standard mode: use raw intensity values
    // Use provided min/max or compute from data
    if (minIntensity === undefined || maxIntensity === undefined) {
      minIntensity = Infinity
      maxIntensity = -Infinity
      for (let i = 0; i < count; i++) {
        minIntensity = Math.min(minIntensity, intensities[i])
        maxIntensity = Math.max(maxIntensity, intensities[i])
      }
    }

    const range = maxIntensity - minIntensity

    for (let i = 0; i < count; i++) {
      const intensity = intensities[i]
      const normalized = range > 0 ? (intensity - minIntensity) / range : 0.5

      const [r, g, b] = applyColormap(normalized, colormap)

      colors[i * 3] = r
      colors[i * 3 + 1] = g
      colors[i * 3 + 2] = b
    }
  }
}

/**
 * Compute colors for points based on classification
 */
export function computeClassificationColors(
  classifications: Uint8Array,
  colors: Uint8Array
) {
  // Standard LAS classification colors
  const classColors: Record<number, [number, number, number]> = {
    0: [128, 128, 128], // Unclassified - gray
    1: [200, 200, 200], // Unclassified - light gray
    2: [160, 82, 45],   // Ground - brown
    3: [34, 139, 34],   // Low Vegetation - green
    4: [50, 205, 50],   // Medium Vegetation - lime green
    5: [0, 128, 0],     // High Vegetation - dark green
    6: [255, 0, 0],     // Building - red
    7: [128, 128, 128], // Noise - gray
    9: [0, 191, 255],   // Water - deep sky blue
    17: [255, 192, 203] // Bridge - pink
  }

  const count = classifications.length
  for (let i = 0; i < count; i++) {
    const classification = classifications[i]
    const color = classColors[classification] || [128, 128, 128]

    colors[i * 3] = color[0]
    colors[i * 3 + 1] = color[1]
    colors[i * 3 + 2] = color[2]
  }
}

/**
 * Spatial bounds for efficient COPC loading
 */
export interface COPCSpatialBounds {
  minLon: number
  maxLon: number
  minLat: number
  maxLat: number
  minAlt: number
  maxAlt: number
}

/**
 * Intensity percentiles for progressive loading
 */
export interface IntensityPercentiles {
  p25: number  // 25th percentile
  p50: number  // 50th percentile (median)
  p75: number  // 75th percentile
  p90: number  // 90th percentile
}

/**
 * Load COPC file with efficient spatial filtering using octree hierarchy
 * Uses HTTP range requests to load only octree nodes that intersect the spatial bounds
 * Supports progressive loading based on intensity threshold for zoom-dependent detail
 */
export async function loadCOPCFileWithSpatialBounds(
  url: string,
  spatialBounds?: COPCSpatialBounds,
  onProgress?: (progress: number) => void,
  intensityThreshold?: number  // Only load points with intensity >= this value (for progressive loading)
): Promise<PointCloudData & { intensityPercentiles?: IntensityPercentiles }> {
  console.log(`[copcLoader] 🚀 Loading COPC file with spatial bounds: ${url}`)

  if (spatialBounds) {
    console.log(`[copcLoader] 📦 Spatial Bounds:`)
    console.log(`  Lon: ${spatialBounds.minLon.toFixed(2)}° to ${spatialBounds.maxLon.toFixed(2)}°`)
    console.log(`  Lat: ${spatialBounds.minLat.toFixed(2)}° to ${spatialBounds.maxLat.toFixed(2)}°`)
    console.log(`  Alt: ${spatialBounds.minAlt.toFixed(2)} to ${spatialBounds.maxAlt.toFixed(2)} km`)
  } else {
    console.log(`[copcLoader] ⚠️  No spatial bounds - will load entire file`)
  }

  // If no spatial bounds, use the simple loader
  if (!spatialBounds) {
    return loadCOPCFile(url, onProgress)
  }

  // Use COPC library for efficient octree-based loading
  const { Copc } = await import('copc')

  // Create HTTP range request getter
  const getter = async (begin: number, end: number): Promise<Uint8Array> => {
    const headers: HeadersInit = {}
    if (begin !== undefined && end !== undefined) {
      headers.Range = `bytes=${begin}-${end - 1}`
    }

    // HTTP range requests are logged only for initial file header (first 64KB)
    // This avoids console spam from hundreds of octree node requests
    if (begin === 0 && end <= 65536) {
      console.log(`[copcLoader] 📡 Loading COPC file header: bytes=${begin}-${end - 1} (${((end - begin) / 1024).toFixed(2)} KB)`)
    }

    const response = await fetch(url, { headers })
    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}: ${response.statusText}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    return new Uint8Array(arrayBuffer)
  }

  // Load COPC metadata
  const copc = await Copc.create(getter)
  console.log(`[copcLoader] ✅ COPC file loaded:`, {
    pointCount: copc.header.pointCount,
    bounds: copc.info.cube,
    spacing: copc.info.spacing
  })

  // Log file bounding box in geographic coordinates
  const fileMinLon = copc.header.min[0] * copc.header.scale[0] + copc.header.offset[0]
  const fileMaxLon = copc.header.max[0] * copc.header.scale[0] + copc.header.offset[0]
  const fileMinLat = copc.header.min[1] * copc.header.scale[1] + copc.header.offset[1]
  const fileMaxLat = copc.header.max[1] * copc.header.scale[1] + copc.header.offset[1]
  const fileMinAlt = copc.header.min[2] * copc.header.scale[2] + copc.header.offset[2]
  const fileMaxAlt = copc.header.max[2] * copc.header.scale[2] + copc.header.offset[2]

  console.log(`[copcLoader] 📊 File Geographic Bounds:`)
  console.log(`  Lon: ${fileMinLon.toFixed(2)}° to ${fileMaxLon.toFixed(2)}°`)
  console.log(`  Lat: ${fileMinLat.toFixed(2)}° to ${fileMaxLat.toFixed(2)}°`)
  console.log(`  Alt: ${fileMinAlt.toFixed(2)} to ${fileMaxAlt.toFixed(2)} km`)
  console.log(`[copcLoader] 🎯 Spatial Filter Bounds:`)
  console.log(`  Lon: ${spatialBounds.minLon}° to ${spatialBounds.maxLon}°`)
  console.log(`  Lat: ${spatialBounds.minLat}° to ${spatialBounds.maxLat}°`)
  console.log(`  Alt: ${spatialBounds.minAlt} to ${spatialBounds.maxAlt} km`)

  // Check if file even intersects the spatial filter
  const fileIntersectsFilter = !(
    fileMaxLon < spatialBounds.minLon ||
    fileMinLon > spatialBounds.maxLon ||
    fileMaxLat < spatialBounds.minLat ||
    fileMinLat > spatialBounds.maxLat ||
    fileMaxAlt < spatialBounds.minAlt ||
    fileMinAlt > spatialBounds.maxAlt
  )

  if (!fileIntersectsFilter) {
    console.log(`[copcLoader] ⚠️  WARNING: Entire file is outside spatial bounds!`)
    console.log(`[copcLoader] 💡 This CALIPSO orbit pass does not cover the requested geographic region`)
    console.log(`[copcLoader] 💡 Try different date/time or disable spatial filter to see where data is located`)
  } else {
    console.log(`[copcLoader] ✅ File intersects spatial filter - proceeding with octree traversal`)
  }

  if (onProgress) onProgress(20)

  // Helper function to check if node bounds intersect spatial filter
  const nodeIntersectsBounds = (node: any): boolean => {
    // Get node bounds in scaled coordinates
    const cube = copc.info.cube
    const spacing = copc.info.spacing

    // Calculate node size based on depth
    // OCTREE DEPTH: Depth 0 is root (biggest), higher depth = smaller nodes
    // Node size DECREASES with depth: size = spacing / (2^depth)
    const [depthStr] = node.key.split('-')
    const depth = parseInt(depthStr)
    const nodeSize = spacing / Math.pow(2, depth)

    // Calculate node bounds in octree coordinate space
    const nodeMin = [
      cube[0] + node.x * nodeSize,
      cube[1] + node.y * nodeSize,
      cube[2] + node.z * nodeSize
    ]
    const nodeMax = [
      nodeMin[0] + nodeSize,
      nodeMin[1] + nodeSize,
      nodeMin[2] + nodeSize
    ]

    // Convert to geographic coordinates using scale/offset
    const minLon = nodeMin[0] * copc.header.scale[0] + copc.header.offset[0]
    const maxLon = nodeMax[0] * copc.header.scale[0] + copc.header.offset[0]
    const minLat = nodeMin[1] * copc.header.scale[1] + copc.header.offset[1]
    const maxLat = nodeMax[1] * copc.header.scale[1] + copc.header.offset[1]
    const minAlt = nodeMin[2] * copc.header.scale[2] + copc.header.offset[2]
    const maxAlt = nodeMax[2] * copc.header.scale[2] + copc.header.offset[2]

    // Check intersection with spatial bounds
    const intersects = !(
      maxLon < spatialBounds.minLon ||
      minLon > spatialBounds.maxLon ||
      maxLat < spatialBounds.minLat ||
      minLat > spatialBounds.maxLat ||
      maxAlt < spatialBounds.minAlt ||
      minAlt > spatialBounds.maxAlt
    )

    return intersects
  }

  // LOD Configuration: Limit octree depth to prevent loading millions of nodes
  // Depth 0 = root (coarsest), higher depths = finer detail
  // For CALIPSO satellite tracks: lower depth = faster loading, higher depth = more detail
  const MAX_DEPTH = 5  // Only load nodes up to this depth level (depth 5-6 for balance)
  const MAX_NODES = 500  // Maximum nodes for fast loading (500 = ~10 seconds, 1000 = ~20 seconds)

  // Recursive function to traverse octree and collect nodes that intersect bounds
  const nodesToLoad: Array<[string, any]> = []
  let totalNodesChecked = 0
  let nodesSkipped = 0
  let depthLimitedNodes = 0

  const traverseAndCollectNodes = async (hierarchyPage: any) => {
    const { nodes, pages } = await Copc.loadHierarchyPage(getter, hierarchyPage)

    for (const [key, node] of Object.entries(nodes)) {
      totalNodesChecked++

      // Check if we've hit max nodes limit
      if (nodesToLoad.length >= MAX_NODES) {
        console.log(`[copcLoader] ⚠️  Reached max nodes limit (${MAX_NODES}) - stopping traversal`)
        return
      }

      // Add key to node for bounds checking
      ;(node as any).key = key
      const [depthStr, xStr, yStr, zStr] = key.split('-').map(Number)
      ;(node as any).x = xStr
      ;(node as any).y = yStr
      ;(node as any).z = zStr

      const depth = depthStr

      // Check depth limit (LOD optimization)
      if (depth > MAX_DEPTH) {
        depthLimitedNodes++
        continue  // Skip nodes deeper than MAX_DEPTH
      }

      // Check if this node intersects spatial bounds
      if (nodeIntersectsBounds(node)) {
        // Node intersects - add it to load list
        nodesToLoad.push([key, node])

        // Only recurse to child pages if we haven't hit depth limit
        if (depth < MAX_DEPTH) {
          for (const [childKey, childPage] of Object.entries(pages)) {
            await traverseAndCollectNodes(childPage as any)
          }
        }
      } else {
        // Node doesn't intersect - skip entire subtree
        nodesSkipped++
      }
    }
  }

  // Start traversal from root
  console.log(`[copcLoader] 🌳 Starting recursive octree traversal with spatial filter`)
  console.log(`[copcLoader] 🎯 LOD settings: MAX_DEPTH=${MAX_DEPTH}, MAX_NODES=${MAX_NODES}`)

  await traverseAndCollectNodes(copc.info.rootHierarchyPage)

  console.log(`[copcLoader] ✅ Found ${nodesToLoad.length} nodes intersecting spatial bounds (depth ≤ ${MAX_DEPTH})`)
  console.log(`[copcLoader] 📉 Skipped ${nodesSkipped} nodes outside bounds, ${depthLimitedNodes} beyond depth limit`)
  console.log(`[copcLoader] ⚡ Total reduction: ${(100 * (nodesSkipped + depthLimitedNodes) / totalNodesChecked).toFixed(1)}%`)

  if (onProgress) onProgress(60)

  // Load point data from filtered nodes
  const positions: number[] = []
  const intensities: number[] = []
  const classifications: number[] = []
  const gpsTimes: number[] = []

  const bounds = {
    min: [Infinity, Infinity, Infinity] as [number, number, number],
    max: [-Infinity, -Infinity, -Infinity] as [number, number, number]
  }

  let totalPointsLoaded = 0

  console.log(`[copcLoader] 📦 Loading point data from ${nodesToLoad.length} nodes...`)

  // Load each node using COPC library (handles decompression internally)
  for (let i = 0; i < nodesToLoad.length; i++) {
    const [key, node] = nodesToLoad[i]

    try {
      // Use COPC library to load this specific node's point data
      const view = await Copc.loadPointDataView(getter, copc, node)

      // Get point count for this node
      const nodePointCount = (node as any).pointCount || 0

      // Only log progress every 100 nodes to avoid console spam
      if (i % 100 === 0 || i === nodesToLoad.length - 1) {
        console.log(`[copcLoader] 📦 Progress: ${i + 1}/${nodesToLoad.length} nodes (${((i + 1) / nodesToLoad.length * 100).toFixed(1)}%)`)
      }

      // Create getters for dimensions
      const getX = view.getter('X')
      const getY = view.getter('Y')
      const getZ = view.getter('Z')
      const getIntensity = view.getter('Intensity')
      const getClassification = view.getter('Classification')
      const getGpsTime = view.getter('GpsTime')

      // Track invalid points for diagnostics
      let invalidCount = 0
      let outOfBoundsCount = 0
      let filteredCount = 0

      // Parse each point in this node
      for (let j = 0; j < nodePointCount; j++) {
        // Get geographic coordinates (already scaled by view.getter())
        const lon = getX(j)
        const lat = getY(j)
        const alt = getZ(j)

        // Validate coordinates - filter out NaN, Infinity, or invalid values
        if (!isFinite(lon) || !isFinite(lat) || !isFinite(alt)) {
          invalidCount++
          // Log first few invalid points for debugging
          if (invalidCount <= 3) {
            console.warn(`[copcLoader] ⚠️  Invalid coordinate in node ${key}, point ${j}: lon=${lon}, lat=${lat}, alt=${alt}`)
          }
          continue // Skip invalid coordinates
        }

        // Validate geographic bounds - reject physically impossible values
        if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
          outOfBoundsCount++
          // Log first few out-of-bounds points for debugging
          if (outOfBoundsCount <= 3) {
            console.warn(`[copcLoader] 🌍 Coordinate outside valid geographic range in node ${key}, point ${j}: lon=${lon}, lat=${lat}, alt=${alt}`)
          }
          continue // Skip coordinates outside valid geographic range
        }

        // Apply per-point spatial filter
        if (lon < spatialBounds.minLon || lon > spatialBounds.maxLon ||
            lat < spatialBounds.minLat || lat > spatialBounds.maxLat ||
            alt < spatialBounds.minAlt || alt > spatialBounds.maxAlt) {
          filteredCount++
          continue // Skip points outside bounds
        }

        // Get intensity for this point
        const intensity = getIntensity(j)

        // Apply intensity threshold filter (for progressive loading)
        if (intensityThreshold !== undefined && intensity < intensityThreshold) {
          filteredCount++
          continue // Skip points below intensity threshold
        }

        // Add point to arrays
        positions.push(lon, lat, alt)
        intensities.push(intensity)
        classifications.push(getClassification(j))
        gpsTimes.push(getGpsTime(j))

        // Update bounds
        bounds.min[0] = Math.min(bounds.min[0], lon)
        bounds.min[1] = Math.min(bounds.min[1], lat)
        bounds.min[2] = Math.min(bounds.min[2], alt)
        bounds.max[0] = Math.max(bounds.max[0], lon)
        bounds.max[1] = Math.max(bounds.max[1], lat)
        bounds.max[2] = Math.max(bounds.max[2], alt)

        totalPointsLoaded++
      }

      // Log filtering statistics for this node
      if (invalidCount > 0 || outOfBoundsCount > 0) {
        console.warn(`[copcLoader] 📊 Node ${key} filtering summary:`)
        if (invalidCount > 0) {
          console.warn(`  • Invalid coordinates (NaN/Infinity): ${invalidCount}`)
        }
        if (outOfBoundsCount > 0) {
          console.warn(`  • Out of geographic bounds: ${outOfBoundsCount}`)
        }
        if (filteredCount > 0) {
          console.warn(`  • Filtered by spatial bounds: ${filteredCount}`)
        }
        console.warn(`  • Valid points kept: ${totalPointsLoaded}`)
      }

      if (onProgress) {
        onProgress(60 + ((i + 1) / nodesToLoad.length) * 35)
      }
    } catch (error) {
      console.error(`[copcLoader] ❌ Failed to load node ${key}:`, error)
    }
  }

  console.log(`[copcLoader] ✅ Loaded ${totalPointsLoaded.toLocaleString()} points from ${nodesToLoad.length} nodes`)
  console.log(`[copcLoader] 📊 Spatial filtering reduced data by ${(100 * (1 - totalPointsLoaded / copc.header.pointCount)).toFixed(1)}%`)

  // Log actual data bounds that were loaded
  if (totalPointsLoaded > 0) {
    console.log(`[copcLoader] 📍 Actual data bounds loaded:`)
    console.log(`  Lon: ${bounds.min[0].toFixed(4)}° to ${bounds.max[0].toFixed(4)}° (range: ${(bounds.max[0] - bounds.min[0]).toFixed(4)}°)`)
    console.log(`  Lat: ${bounds.min[1].toFixed(4)}° to ${bounds.max[1].toFixed(4)}° (range: ${(bounds.max[1] - bounds.min[1]).toFixed(4)}°)`)
    console.log(`  Alt: ${bounds.min[2].toFixed(2)} to ${bounds.max[2].toFixed(2)} km (range: ${(bounds.max[2] - bounds.min[2]).toFixed(2)} km)`)
    console.log(`[copcLoader] 🎯 Requested spatial filter:`)
    console.log(`  Lon: ${spatialBounds.minLon.toFixed(2)}° to ${spatialBounds.maxLon.toFixed(2)}°`)
    console.log(`  Lat: ${spatialBounds.minLat.toFixed(2)}° to ${spatialBounds.maxLat.toFixed(2)}°`)
    console.log(`  Alt: ${spatialBounds.minAlt.toFixed(2)} to ${spatialBounds.maxAlt.toFixed(2)} km`)

    // Log sample coordinates to verify data quality
    console.log(`[copcLoader] 🔍 Sample coordinates from loaded data (first 20 points):`)
    const sampleSize = Math.min(20, totalPointsLoaded)
    for (let i = 0; i < sampleSize; i++) {
      const lon = positions[i * 3]
      const lat = positions[i * 3 + 1]
      const alt = positions[i * 3 + 2]
      console.log(`  Point ${i}: lon=${lon.toFixed(4)}°, lat=${lat.toFixed(4)}°, alt=${alt.toFixed(2)} km`)
    }
  }

  if (totalPointsLoaded === 0) {
    console.warn(`[copcLoader] ⚠️  No points found within spatial bounds`)
    console.warn(`[copcLoader] 💡 Try adjusting your spatial filter to match the data location`)
  }

  // Convert arrays to typed arrays
  const positionsArray = new Float32Array(positions)
  const intensitiesArray = new Uint16Array(intensities)
  const classificationsArray = new Uint8Array(classifications)
  const gpsTimesArray = new Float64Array(gpsTimes)
  const colors = new Uint8Array(totalPointsLoaded * 3)

  // Find first and last points based on GPS time
  let firstPoint: { lon: number, lat: number, alt: number, gpsTime: number } | undefined
  let lastPoint: { lon: number, lat: number, alt: number, gpsTime: number } | undefined

  if (totalPointsLoaded > 0) {
    let minGpsTime = Infinity
    let maxGpsTime = -Infinity
    let minIdx = 0
    let maxIdx = 0

    for (let i = 0; i < totalPointsLoaded; i++) {
      if (gpsTimesArray[i] < minGpsTime) {
        minGpsTime = gpsTimesArray[i]
        minIdx = i
      }
      if (gpsTimesArray[i] > maxGpsTime) {
        maxGpsTime = gpsTimesArray[i]
        maxIdx = i
      }
    }

    firstPoint = {
      lon: positionsArray[minIdx * 3],
      lat: positionsArray[minIdx * 3 + 1],
      alt: positionsArray[minIdx * 3 + 2],
      gpsTime: minGpsTime
    }

    lastPoint = {
      lon: positionsArray[maxIdx * 3],
      lat: positionsArray[maxIdx * 3 + 1],
      alt: positionsArray[maxIdx * 3 + 2],
      gpsTime: maxGpsTime
    }
  }

  // Calculate intensity percentiles for progressive loading
  // Only calculate if no threshold was applied (i.e., this is the initial load)
  let intensityPercentiles: IntensityPercentiles | undefined
  if (intensityThreshold === undefined && totalPointsLoaded > 0) {
    // Sort intensity values to find percentiles
    const sortedIntensities = Array.from(intensitiesArray).sort((a, b) => a - b)

    // Convert LAS intensity values to physical units for percentile thresholds
    // CALIPSO encoding: intensity = (physical + 0.1) * 10000
    // Physical units: km⁻¹·sr⁻¹
    const lasToPhysical = (lasValue: number) => (lasValue / 10000.0) - 0.1

    intensityPercentiles = {
      p25: lasToPhysical(sortedIntensities[Math.floor(sortedIntensities.length * 0.25)]),
      p50: lasToPhysical(sortedIntensities[Math.floor(sortedIntensities.length * 0.50)]),
      p75: lasToPhysical(sortedIntensities[Math.floor(sortedIntensities.length * 0.75)]),
      p90: lasToPhysical(sortedIntensities[Math.floor(sortedIntensities.length * 0.90)])
    }

    console.log(`[copcLoader] 📊 Intensity percentiles calculated (physical units):`)
    console.log(`  • 25th percentile (p25): ${intensityPercentiles.p25.toFixed(4)} km⁻¹·sr⁻¹`)
    console.log(`  • 50th percentile (p50): ${intensityPercentiles.p50.toFixed(4)} km⁻¹·sr⁻¹`)
    console.log(`  • 75th percentile (p75): ${intensityPercentiles.p75.toFixed(4)} km⁻¹·sr⁻¹`)
    console.log(`  • 90th percentile (p90): ${intensityPercentiles.p90.toFixed(4)} km⁻¹·sr⁻¹`)
    console.log(`  💡 These thresholds enable progressive loading based on zoom level`)
  }

  if (onProgress) onProgress(100)

  return {
    positions: positionsArray,
    colors,
    intensities: intensitiesArray,
    classifications: classificationsArray,
    gpsTimes: gpsTimesArray,
    count: totalPointsLoaded,
    pointCount: totalPointsLoaded,
    bounds,
    firstPoint,
    lastPoint,
    intensityPercentiles
  }
}
