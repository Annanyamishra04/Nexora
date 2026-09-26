import { clsx, type ClassValue } from "clsx";

/**
 * Merge conditional class names. We intentionally skip tailwind-merge to
 * avoid an extra dependency; class collisions are avoided by keeping
 * component variants mutually exclusive.
 */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}
