import { defaultDeps, handleLogout } from '../_lib/handlers.js'

/** POST /api/auth/logout — revoke (best effort) and clear the session cookie. */
export default {
  fetch(request: Request): Promise<Response> {
    return handleLogout(request, defaultDeps())
  },
}
