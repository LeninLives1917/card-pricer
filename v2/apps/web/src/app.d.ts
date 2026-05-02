// Ambient types for the app.

declare global {
  namespace App {
    interface Locals {
      /** Set by hooks.server.ts when a Supabase JWT is valid. */
      user: { id: string; email: string | null } | null;
    }
  }
}

export {};
