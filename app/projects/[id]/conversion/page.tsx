"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import OfferForm from "@/components/Offers/OfferForm";
import OfferList from "@/components/Offers/OfferList";
import type { Offer } from "@/lib/offers";

export default function ConversionPage() {
  const params = useParams();
  const projectId = params.id as string;

  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchOffers() {
      const res = await fetch(`/api/offers?project_id=${projectId}`);
      if (res.ok) {
        const data = await res.json();
        setOffers(data);
      } else {
        setError("Failed to load offers.");
      }
      setLoading(false);
    }
    fetchOffers();
  }, [projectId]);

  function handleCreated(offer: Offer) {
    setOffers((prev) => [offer, ...prev]);
  }

  function handleUpdated(updated: Offer) {
    setOffers((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
  }

  const accepted = offers.filter((o) => o.status === "accepted").length;
  const sent = offers.filter((o) => o.status === "sent").length;
  const conversionRate =
    sent + accepted > 0 ? Math.round((accepted / (sent + accepted)) * 100) : null;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 py-12 px-4">
      <div className="mx-auto max-w-2xl space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Paid Conversion</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Build and track offers to convert prospects into paying customers.
          </p>
        </div>

        {/* Stats */}
        {offers.length > 0 && (
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: "Total Offers", value: offers.length },
              { label: "Accepted", value: accepted },
              {
                label: "Conversion Rate",
                value: conversionRate !== null ? `${conversionRate}%` : "—",
              },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-4 text-center"
              >
                <p className="text-2xl font-bold text-gray-900 dark:text-white">{stat.value}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{stat.label}</p>
              </div>
            ))}
          </div>
        )}

        {/* Create offer */}
        <div className="rounded-lg bg-white dark:bg-gray-800 p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            New Offer
          </h2>
          <OfferForm projectId={projectId} onCreated={handleCreated} />
        </div>

        {/* Offer list */}
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
            Offers
          </h2>
          {loading ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">Loading...</p>
          ) : error ? (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          ) : (
            <OfferList offers={offers} onUpdated={handleUpdated} />
          )}
        </div>
      </div>
    </div>
  );
}
