/* CANARY — proves that a Vercel serverless function can import a module from OUTSIDE api/.
   Nothing on this project had ever done that, and the failure mode is a runtime
   "Cannot find module" visible only after deploy. Delete once shared/roles.js has shipped
   and proven the same thing for real. */
export const SHARED_BOUNDARY_OK = "shared/ reachable from api/";
