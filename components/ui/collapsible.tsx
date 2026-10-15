"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./Button";

export interface CollapsibleProps {
  /** Label of the button that opens and closes the block. */
  trigger: React.ReactNode;
  /** Shown while collapsed, e.g. «نمایش بیشتر»; the trigger label is used when open. */
  openLabel?: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * بازشو. Shows or hides a block with a height transition (CSS grid rows,
 * so no measuring). Content stays in the DOM and keeps its state.
 */
export function Collapsible({ trigger, openLabel, open, defaultOpen = false, onOpenChange, disabled, className, children }: CollapsibleProps) {
  const [internal, setInternal] = React.useState(defaultOpen);
  const isOpen = open ?? internal;
  const id = React.useId();

  function toggle() {
    if (open === undefined) setInternal(!isOpen);
    onOpenChange?.(!isOpen);
  }

  const label = isOpen && openLabel !== undefined ? openLabel : trigger;

  return (
    <div className={className}>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={isOpen}
        aria-controls={id}
        disabled={disabled}
        onClick={toggle}
        className="px-2 font-medium text-foreground/90"
      >
        {label}
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform duration-200", isOpen && "rotate-180")} aria-hidden />
      </Button>
      <div
        id={id}
        role="region"
        aria-hidden={!isOpen}
        className={cn("grid transition-[grid-template-rows] duration-200 ease-out", isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}
      >
        {/* inert keeps hidden links and fields out of the tab order while the rows animate. */}
        <div inert={!isOpen} className="min-h-0 overflow-hidden">
          <div className="pt-2">{children}</div>
        </div>
      </div>
    </div>
  );
}