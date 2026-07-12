"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ModeBadge } from "@/components/ui";
import { useApi } from "@/components/useApi";
import type { StatusResponse } from "@/lib/types";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/usage", label: "Usage" },
  { href: "/costs", label: "Costs" },
  { href: "/insights", label: "Insights" },
  { href: "/compare", label: "Compare" },
] as const;

export function TopNav() {
  const pathname = usePathname();
  const status = useApi<StatusResponse>("/api/status");

  return (
    <header className="border-b border-hairline bg-card">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          Energy Monitor
        </Link>
        <nav className="flex items-center gap-1" aria-label="Main">
          {LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-md px-2.5 py-1 text-sm transition-colors ${
                  active
                    ? "bg-foreground/10 font-medium text-foreground"
                    : "text-muted hover:bg-foreground/5"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto">
          <ModeBadge mode={status.data?.mode} />
        </div>
      </div>
    </header>
  );
}
