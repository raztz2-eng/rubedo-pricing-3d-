import { defaultDeps, handleCallback } from '../_lib/handlers.js'

/** GET /api/auth/callback — verify state + account, set the encrypted session cookie. */
export default {
  fetch(request: Request): Promise<Response> {
    return handleCallback(request, defaultDeps())
  },
}
