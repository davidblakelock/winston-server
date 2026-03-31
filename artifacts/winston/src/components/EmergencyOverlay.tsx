import { useEffect } from "react";
import { Phone, X, MapPin, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmergencyOverlayProps {
  onDismiss: () => void;
}

export function EmergencyOverlay({ onDismiss }: EmergencyOverlayProps) {
  // Lock body scroll while overlay is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onDismiss]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm animate-in fade-in duration-200"
      role="alertdialog"
      aria-modal="true"
      aria-label="Emergency information"
    >
      <div className="relative mx-4 w-full max-w-md rounded-2xl border border-red-500/40 bg-[#1a0a0a] shadow-2xl shadow-red-900/30 p-6 sm:p-8 animate-in zoom-in-95 duration-200">

        {/* Close button */}
        <button
          onClick={onDismiss}
          className="absolute top-4 right-4 text-white/40 hover:text-white/80 transition-colors"
          aria-label="Dismiss emergency overlay"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-600/20 border border-red-500/30">
            <AlertTriangle className="h-5 w-5 text-red-400" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-red-400/80">Emergency</p>
            <p className="text-white font-semibold text-base">I'm here, David</p>
          </div>
        </div>

        {/* 911 CTA — prominent */}
        <div className="mb-5 rounded-xl bg-red-600 p-4 text-center shadow-lg shadow-red-900/40">
          <p className="text-xs font-bold uppercase tracking-widest text-red-200 mb-1">Emergency Services</p>
          <p className="text-5xl font-black text-white tracking-wider">9-1-1</p>
          <p className="text-sm text-red-200 mt-1">Call immediately if in danger</p>
        </div>

        {/* Address card */}
        <div className="mb-5 rounded-xl bg-white/5 border border-white/10 p-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-white/50 mb-1 flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5" />
            Your Home Address
          </p>
          <p className="text-white text-base font-medium leading-snug">
            6345 Diamond Head Circle<br />
            Dallas, Texas 75225
          </p>
          <p className="text-xs text-white/40 mt-1">Give this to emergency services</p>
        </div>

        {/* Quick actions */}
        <div className="flex flex-col gap-2">
          <a
            href="tel:911"
            className="flex items-center justify-center gap-2.5 rounded-xl bg-red-600 hover:bg-red-700 active:bg-red-800 text-white font-semibold text-base py-3 transition-colors shadow-md"
            onClick={onDismiss}
          >
            <Phone className="h-5 w-5" />
            Call 911 Now
          </a>

          <Button
            variant="ghost"
            className="w-full border border-white/10 text-white/60 hover:text-white hover:bg-white/5 font-medium"
            onClick={onDismiss}
          >
            I'm okay — dismiss
          </Button>
        </div>

        {/* Emma reassurance */}
        <p className="mt-4 text-center text-xs text-white/30 italic">
          Stay calm. Help is on the way.
        </p>
      </div>
    </div>
  );
}
