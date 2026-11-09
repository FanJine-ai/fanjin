import dotenv from "dotenv";
// Public profile: no system credential-store integration.
if (process.env.FANJIN_LOAD_LOCAL_ENV === "1") dotenv.config();
process.env.NODE_ENV ||= "prod";
