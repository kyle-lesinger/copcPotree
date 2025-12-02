import { SpatialBoundsFilter, DateRangeFilter as DateRangeFilterType, DataRange, BandType } from '../App'
import { LatLon } from '../utils/aoiSelector'
import DayNightBandFilter from './DayNightBandFilter'
import DateRangeFilterComponent from './DateRangeFilter'
import SpatialBoundsPanel from './SpatialBoundsPanel'
import './FilterPanel.css'

interface FilterPanelProps {
  // Band filter
  selectedBand: BandType
  onBandChange: (band: BandType) => void
  // Date range filter
  dateRangeFilter: DateRangeFilterType
  onDateRangeFilterChange: (updates: Partial<DateRangeFilterType>) => void
  onResetDateRangeFilter: () => void
  // Spatial bounds filter
  spatialBoundsFilter: SpatialBoundsFilter
  onSpatialBoundsFilterChange: (updates: Partial<SpatialBoundsFilter>) => void
  onResetSpatialBoundsFilter: () => void
  // Data ranges for validation
  globalDataRange: DataRange
  // AOI polygon
  aoiPolygon: LatLon[] | null
}

export default function FilterPanel({
  selectedBand,
  onBandChange,
  dateRangeFilter,
  onDateRangeFilterChange,
  onResetDateRangeFilter,
  spatialBoundsFilter,
  onSpatialBoundsFilterChange,
  onResetSpatialBoundsFilter,
  globalDataRange,
  aoiPolygon
}: FilterPanelProps) {
  return (
    <div className="panel filter-panel">
      <h3>Data Filters</h3>

      <DayNightBandFilter
        selectedBand={selectedBand}
        onBandChange={onBandChange}
      />

      <DateRangeFilterComponent
        startDate={dateRangeFilter.startDate}
        endDate={dateRangeFilter.endDate}
        onApply={(start, end) => onDateRangeFilterChange({ startDate: start, endDate: end })}
        onReset={onResetDateRangeFilter}
        enabled={dateRangeFilter.enabled}
        onToggleEnabled={() => onDateRangeFilterChange({ enabled: !dateRangeFilter.enabled })}
      />

      <SpatialBoundsPanel
        minLon={spatialBoundsFilter.minLon}
        maxLon={spatialBoundsFilter.maxLon}
        minLat={spatialBoundsFilter.minLat}
        maxLat={spatialBoundsFilter.maxLat}
        minAlt={spatialBoundsFilter.minAlt}
        maxAlt={spatialBoundsFilter.maxAlt}
        useUSBounds={spatialBoundsFilter.useUSBounds}
        useAOIBounds={spatialBoundsFilter.useAOIBounds}
        hasAOI={aoiPolygon !== null && aoiPolygon.length >= 3}
        absoluteBounds={globalDataRange.elevation ? {
          minLon: -180,
          maxLon: 180,
          minLat: -90,
          maxLat: 90,
          minAlt: globalDataRange.elevation[0],
          maxAlt: globalDataRange.elevation[1]
        } : null}
        onApply={(bounds) => onSpatialBoundsFilterChange(bounds)}
        onReset={onResetSpatialBoundsFilter}
        onToggleUSBounds={() => onSpatialBoundsFilterChange({ useUSBounds: !spatialBoundsFilter.useUSBounds })}
        onToggleAOIBounds={() => onSpatialBoundsFilterChange({ useAOIBounds: !spatialBoundsFilter.useAOIBounds })}
        enabled={spatialBoundsFilter.enabled}
        onToggleEnabled={() => onSpatialBoundsFilterChange({ enabled: !spatialBoundsFilter.enabled })}
      />
    </div>
  )
}
