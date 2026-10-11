"use client"

import "@/lib/style-nonce" // must come first: sonner injects a <style> element when it loads
import { useEffect } from "react"
import { useTheme } from "next-themes"
import { toast, Toaster as Sonner, type ExternalToast, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

const AUTO_DISMISS_MS = 5_000

/**
 * Sonner closes every toast on a timer and has no per-kind default. The app's rule (W07 AS-15): success and info close
 * after 5 s (`duration` on the Toaster), while errors and any toast with an action stay until dismissed. Applied once to
 * the shared `toast` helpers so callers need no change.
 */
let persistenceApplied = false
function persistErrorsAndActions() {
  if (persistenceApplied) return
  persistenceApplied = true
  type Method = (message: React.ReactNode, data?: ExternalToast) => string | number
  const methods = toast as unknown as Record<"error" | "success" | "info" | "warning" | "message", Method>
  for (const kind of ["error", "success", "info", "warning", "message"] as const) {
    const original = methods[kind].bind(toast)
    methods[kind] = (message, data) =>
      original(message, {
        ...(kind === "error" || data?.action ? { duration: Infinity } : {}),
        ...data,
      })
  }
}
persistErrorsAndActions()

/** Sonner marks no role: errors are announced assertively, everything else politely. */
function useToastPoliteness() {
  useEffect(() => {
    const apply = () => {
      for (const item of document.querySelectorAll<HTMLElement>("li[data-sonner-toast]")) {
        const error = item.dataset.type === "error"
        item.setAttribute("role", error ? "alert" : "status")
        item.setAttribute("aria-live", error ? "assertive" : "polite")
      }
    }
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
}

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()
  useToastPoliteness()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="bottom-right"
      visibleToasts={3}
      duration={AUTO_DISMISS_MS}
      closeButton
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        closeButtonAriaLabel: "Dismiss",
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
