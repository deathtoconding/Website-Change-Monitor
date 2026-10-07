import { Sparkles } from "lucide-react";
import { getDomain } from "../lib/monitoring";

interface BrandMarkProps {
  url?: string;
  size?: "small" | "normal" | "large";
}

const BRAND_STYLES: Record<string, string> = {
  linear: "brand-linear",
  stripe: "brand-stripe",
  notion: "brand-notion",
  vercel: "brand-vercel",
  ramp: "brand-ramp",
  intercom: "brand-intercom",
  github: "brand-github",
  figma: "brand-figma",
};

export function BrandMark({ url, size = "normal" }: BrandMarkProps) {
  if (!url) {
    return (
      <span className={`brand-mark brand-product brand-${size}`}>
        <Sparkles size={size === "small" ? 14 : 17} strokeWidth={2.2} />
      </span>
    );
  }

  const domain = getDomain(url);
  const brandName = domain.split(".")[0]?.toLowerCase() ?? "";
  const style = BRAND_STYLES[brandName] ?? "brand-default";
  const initial = brandName.slice(0, 1).toUpperCase() || "W";

  return (
    <span className={`brand-mark ${style} brand-${size}`} aria-hidden="true">
      {brandName === "vercel" ? <span className="vercel-triangle" /> : initial}
    </span>
  );
}
