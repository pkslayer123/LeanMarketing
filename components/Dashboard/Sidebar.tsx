import Link from 'next/link';

const navItems = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/settings', label: 'Settings' },
];

export default function Sidebar() {
  return (
    <aside className="w-52 shrink-0 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 min-h-screen p-4 flex flex-col">
      <div className="mb-8">
        <span className="text-lg font-bold text-gray-900 dark:text-white tracking-tight">
          LeanMarketing
        </span>
      </div>
      <nav className="space-y-1 flex-1">
        {navItems.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center px-3 py-2 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            {label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
