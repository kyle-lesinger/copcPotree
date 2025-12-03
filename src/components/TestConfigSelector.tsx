import { useState } from 'react'
import './TestConfigSelector.css'

export interface TestConfig {
  testId: string
  name: string
  filename: string
  bounds: {
    minLat: number
    maxLat: number
    minLon: number
    maxLon: number
  }
  maxDepth: number
  pointBudget: number
  lodStrategy: string
  lodThreshold: number
  decimation: string | null
  pointSize: number
  expectedFps: number
  useCase: string
}

// Import test configurations
const TEST_CONFIGS: Record<string, TestConfig> = {
  T049: {
    testId: 'T049',
    name: 'Recommended - Fast (60 FPS)',
    filename: 'CAL_LID_L1-Standard-V4-51.2023-06-30T16-44-43ZD.copc.laz',
    bounds: { minLat: -20, maxLat: 20, minLon: -30, maxLon: 30 },
    maxDepth: 3,
    pointBudget: 1000000,
    lodStrategy: 'frustum_and_distance',
    lodThreshold: 15,
    decimation: null,
    pointSize: 2,
    expectedFps: 60,
    useCase: 'Best for smooth navigation and presentations'
  },
  T050: {
    testId: 'T050',
    name: 'Recommended - Balanced',
    filename: 'CAL_LID_L1-Standard-V4-51.2023-06-30T16-44-43ZD.copc.laz',
    bounds: { minLat: -20, maxLat: 20, minLon: -30, maxLon: 30 },
    maxDepth: 4,
    pointBudget: 2000000,
    lodStrategy: 'screen_space_error',
    lodThreshold: 2.0,
    decimation: null,
    pointSize: 2,
    expectedFps: 50,
    useCase: 'Best overall default configuration'
  },
  T001: {
    testId: 'T001',
    name: 'Minimal - Very Low Detail',
    filename: 'CAL_LID_L1-Standard-V4-51.2023-06-30T16-44-43ZD.copc.laz',
    bounds: { minLat: -20, maxLat: 20, minLon: -30, maxLon: 30 },
    maxDepth: 0,
    pointBudget: 100000,
    lodStrategy: 'distance_based',
    lodThreshold: 100,
    decimation: null,
    pointSize: 3,
    expectedFps: 60,
    useCase: 'Initial overview, fastest loading'
  },
  T003: {
    testId: 'T003',
    name: 'Medium Detail - Depth 2',
    filename: 'CAL_LID_L1-Standard-V4-51.2023-06-30T16-44-43ZD.copc.laz',
    bounds: { minLat: -20, maxLat: 20, minLon: -30, maxLon: 30 },
    maxDepth: 2,
    pointBudget: 500000,
    lodStrategy: 'distance_based',
    lodThreshold: 25,
    decimation: null,
    pointSize: 2,
    expectedFps: 60,
    useCase: 'Good balance for interactive exploration'
  },
  T004: {
    testId: 'T004',
    name: 'High Detail - Depth 3',
    filename: 'CAL_LID_L1-Standard-V4-51.2023-06-30T16-44-43ZD.copc.laz',
    bounds: { minLat: -20, maxLat: 20, minLon: -30, maxLon: 30 },
    maxDepth: 3,
    pointBudget: 1000000,
    lodStrategy: 'distance_based',
    lodThreshold: 10,
    decimation: null,
    pointSize: 2,
    expectedFps: 50,
    useCase: 'Detailed view for analysis'
  },
  T005: {
    testId: 'T005',
    name: 'Very High Detail - Depth 4',
    filename: 'CAL_LID_L1-Standard-V4-51.2023-06-30T16-44-43ZD.copc.laz',
    bounds: { minLat: -20, maxLat: 20, minLon: -30, maxLon: 30 },
    maxDepth: 4,
    pointBudget: 2000000,
    lodStrategy: 'distance_based',
    lodThreshold: 5,
    decimation: null,
    pointSize: 2,
    expectedFps: 40,
    useCase: 'Maximum detail, may impact performance'
  }
}

interface TestConfigSelectorProps {
  onConfigSelect: (config: TestConfig) => void
  currentTestId?: string
}

export default function TestConfigSelector({ onConfigSelect, currentTestId }: TestConfigSelectorProps) {
  const [selectedConfig, setSelectedConfig] = useState<TestConfig | null>(
    currentTestId ? TEST_CONFIGS[currentTestId] : null
  )

  const handleSelectConfig = (testId: string) => {
    const config = TEST_CONFIGS[testId]
    setSelectedConfig(config)
    onConfigSelect(config)
    console.log(`[TestConfig] Applied ${testId}: ${config.name}`)
  }

  return (
    <div className="test-config-selector-inline">
      <div className="test-config-dropdown">
        <select
          value={selectedConfig?.testId || ''}
          onChange={(e) => e.target.value && handleSelectConfig(e.target.value)}
          className="control-select"
        >
          <option value="">Select a test configuration...</option>
          {Object.entries(TEST_CONFIGS).map(([id, config]) => (
            <option key={id} value={id}>
              {config.testId} - {config.name} ({config.expectedFps} FPS)
            </option>
          ))}
        </select>
      </div>

      {selectedConfig && (
        <div className="test-config-panel-inline">
          <div className="test-config-info">
            <div className="config-row">
              <span>Test ID:</span>
              <span>{selectedConfig.testId}</span>
            </div>
            <div className="config-row">
              <span>Max Depth:</span>
              <span>{selectedConfig.maxDepth}</span>
            </div>
            <div className="config-row">
              <span>Point Budget:</span>
              <span>{selectedConfig.pointBudget.toLocaleString()}</span>
            </div>
            <div className="config-row">
              <span>Point Size:</span>
              <span>{selectedConfig.pointSize}px</span>
            </div>
            <div className="config-row">
              <span>Expected FPS:</span>
              <span>{selectedConfig.expectedFps}</span>
            </div>
            <div className="config-row">
              <span>Bounds:</span>
              <span>Lat {selectedConfig.bounds.minLat}° to {selectedConfig.bounds.maxLat}°</span>
            </div>
            <div className="config-row">
              <span></span>
              <span>Lon {selectedConfig.bounds.minLon}° to {selectedConfig.bounds.maxLon}°</span>
            </div>
            <div className="config-use-case">
              💡 {selectedConfig.useCase}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
