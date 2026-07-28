import { config } from "dotenv";

// Load env vars before anything else imports the sandbox backends.
// .env        -> your ANTHROPIC_API_KEY, SANDBOX_BACKEND, etc.
// .env.local  -> written by `vercel env pull` (VERCEL_OIDC_TOKEN); does not
//                override values already set in .env.
config();
config({ path: ".env.local", override: false });
