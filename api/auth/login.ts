import { defaultDeps, handleLogin } from '../_lib/handlers.js'

/** GET /api/auth/login — redirect to Google consent (brief v0.4). */
export default {
  fetch(request: Request): Promise<Response> {
    return handleLogin(request, defaultDeps())
  },
}
