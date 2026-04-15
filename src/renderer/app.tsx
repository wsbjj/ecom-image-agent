import { HashRouter, Routes, Route, NavLink } from 'react-router-dom'
import { Dashboard } from './pages/Dashboard'
import { TaskRun } from './pages/TaskRun'
import { Gallery } from './pages/Gallery'
import { Templates } from './pages/Templates'
import { Settings } from './pages/Settings'

const NAV_ITEMS = [
  { to: '/', label: '仪表盘', icon: '📊' },
  { to: '/task-run', label: '任务执行', icon: '▶️' },
  { to: '/gallery', label: '图片画廊', icon: '🖼️' },
  { to: '/templates', label: '提示词模板', icon: '📝' },
  { to: '/settings', label: '设置', icon: '⚙️' },
] as const

function Sidebar() {
  return (
    <nav className="w-56 bg-gray-900/80 border-r border-gray-700/50 flex flex-col">
      <div className="p-4 border-b border-gray-700/50">
        <h1 className="text-lg font-bold text-gray-100 tracking-tight">
          EcomAgent
        </h1>
        <div className="text-xs text-gray-500 mt-0.5">电商精品图 Agent</div>
      </div>

      <div className="flex-1 py-2 space-y-0.5">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                isActive
                  ? 'bg-blue-600/20 text-blue-400 border-r-2 border-r-blue-500'
                  : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
              }`
            }
          >
            <span className="text-base">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </div>

      <div className="p-4 border-t border-gray-700/50 text-xs text-gray-600">
        v1.0.0
      </div>
    </nav>
  )
}

export function App() {
  return (
    <HashRouter>
      <div className="flex h-screen bg-gray-950 text-gray-100">
        <Sidebar />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/task-run" element={<TaskRun />} />
          <Route path="/gallery" element={<Gallery />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </div>
    </HashRouter>
  )
}
