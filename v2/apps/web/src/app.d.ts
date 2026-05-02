// Ambient types for the app. Populated as we wire auth + locals in week 2.

declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      // Set by hooks.server.ts when a Supabase JWT is valid.
      user: { id: string; email: string | null } | null;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
