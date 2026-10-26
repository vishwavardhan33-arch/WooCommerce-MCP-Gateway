import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Joins class names and resolves Tailwind conflicts: cn("p-2", cond && "p-4") ends up with only p-4.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
