'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function NetworkSyncButton() {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const router = useRouter();

  async function handleSync() {
    setSyncing(true);
    setResult(null);

    try {
      const resp = await fetch('/api/daemon-network/sync', { method: 'POST' });
      const data = await resp.json();

      if (data.ok) {
        setResult(`Synced ${data.synced} project${data.synced !== 1 ? 's' : ''} from ${data.nodeCount} node${data.nodeCount !== 1 ? 's' : ''}`);
        router.refresh();
      } else {
        setResult(data.error || 'Sync failed');
      }
    } catch (err) {
      setResult(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {result && (
        <span className="text-xs text-gray-500 dark:text-gray-400">{result}</span>
      )}
      <button
        onClick={handleSync}
        disabled={syncing}
        className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {syncing ? (
          <>
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Syncing...
          </>
        ) : (
          <>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Sync Network
          </>
        )}
      </button>
    </div>
  );
}
