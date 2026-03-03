"use client";

import { useState } from "react";
import {
  TEMPLATE_LABELS,
  formatPrice,
  type Offer,
  type OfferStatus,
} from "@/lib/offers";

interface OfferListProps {
  offers: Offer[];
  onUpdated: (offer: Offer) => void;
}

const STATUS_COLORS: Record<OfferStatus, string> = {
  draft: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  sent: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  accepted: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  declined: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  expired: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300",
};

const STATUS_TRANSITIONS: Record<OfferStatus, OfferStatus[]> = {
  draft: ["sent"],
  sent: ["accepted", "declined", "expired"],
  accepted: [],
  declined: [],
  expired: [],
};

function OfferCard({ offer, onUpdated }: { offer: Offer; onUpdated: (o: Offer) => void }) {
  const [loading, setLoading] = useState(false);
  const [sentTo, setSentTo] = useState(offer.sent_to ?? "");
  const [showSentToInput, setShowSentToInput] = useState(false);
  const transitions = STATUS_TRANSITIONS[offer.status];

  async function updateStatus(status: OfferStatus) {
    setLoading(true);
    const body: { status: OfferStatus; sent_to?: string } = { status };
    if (status === "sent" && sentTo.trim()) {
      body.sent_to = sentTo.trim();
    }
    const res = await fetch(`/api/offers/${offer.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const updated = await res.json();
      onUpdated(updated);
      setShowSentToInput(false);
    }
    setLoading(false);
  }

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {TEMPLATE_LABELS[offer.template]}
          </span>
          <p className="mt-0.5 text-sm text-gray-900 dark:text-white line-clamp-2">{offer.scope}</p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_COLORS[offer.status]}`}
        >
          {offer.status.replace("_", " ")}
        </span>
      </div>

      {/* Details */}
      <div className="flex gap-4 text-sm text-gray-600 dark:text-gray-400">
        <span>{offer.duration_days}d</span>
        <span>{formatPrice(offer.price_cents)}</span>
        {offer.sent_to && <span>→ {offer.sent_to}</span>}
      </div>

      {/* Quality gate badge */}
      {offer.quality_gate_passed !== null && (
        <div
          className={`text-xs rounded px-2 py-1 inline-block ${
            offer.quality_gate_passed
              ? "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400"
              : "bg-yellow-50 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400"
          }`}
        >
          QG5 {offer.quality_gate_passed ? "Passed" : "Not Passed"}
        </div>
      )}

      {/* Success definition */}
      <p className="text-xs text-gray-500 dark:text-gray-400 italic">{offer.success_definition}</p>

      {/* Actions */}
      {transitions.length > 0 && (
        <div className="space-y-2 pt-1">
          {transitions.includes("sent") && (
            <div>
              {showSentToInput ? (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={sentTo}
                    onChange={(e) => setSentTo(e.target.value)}
                    placeholder="Recipient name or email"
                    className="flex-1 rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                  />
                  <button
                    onClick={() => updateStatus("sent")}
                    disabled={loading}
                    className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                  >
                    {loading ? "..." : "Send"}
                  </button>
                  <button
                    onClick={() => setShowSentToInput(false)}
                    className="rounded-md border border-gray-300 px-3 py-1 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowSentToInput(true)}
                  className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-500"
                >
                  Mark as Sent
                </button>
              )}
            </div>
          )}
          <div className="flex gap-2 flex-wrap">
            {transitions.filter((t) => t !== "sent").map((t) => (
              <button
                key={t}
                onClick={() => updateStatus(t)}
                disabled={loading}
                className={`rounded-md px-3 py-1 text-sm font-medium disabled:opacity-50 ${
                  t === "accepted"
                    ? "bg-green-600 text-white hover:bg-green-500"
                    : "border border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400"
                }`}
              >
                {loading ? "..." : `Mark ${t}`}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function OfferList({ offers, onUpdated }: OfferListProps) {
  if (offers.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-6">
        No offers yet. Create your first offer above.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {offers.map((offer) => (
        <OfferCard key={offer.id} offer={offer} onUpdated={onUpdated} />
      ))}
    </div>
  );
}
