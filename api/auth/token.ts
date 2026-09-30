import { defaultDeps, handleToken } from '../_lib/handlers.js'

/** POST /api/auth/token — session cookie → short-lived access token for the SPA. */
export default {
  fetch(request: Request): Promise<Response> {
    return handleToken(request, defaultDeps())
  },
}
