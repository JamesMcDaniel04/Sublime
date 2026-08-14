import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * The scroll behaviour to request, honouring the user's motion preference.
 *
 * The global `@media (prefers-reduced-motion)` rule in globals.css forces
 * `scroll-behavior: auto`, but that only governs CSS-driven scrolling. An
 * explicit `element.scrollTo({ behavior: 'smooth' })` passes its own option and
 * overrides the stylesheet — so every JS-driven smooth scroll stays animated
 * for someone who asked the OS for less motion. This is how they opt out.
 */
export function scrollBehavior(): ScrollBehavior {
  if (typeof window === 'undefined' || !window.matchMedia) return 'smooth'
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}
