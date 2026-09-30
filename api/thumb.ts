import { defaultDeps, handleThumb } from './_lib/handlers.js'

/** GET /api/thumb?id=&s= — authenticated Drive thumbnail proxy (HEIC-safe, no CORS). */
export default {
  fetch(request: Request): Promise<Response> {
    return handleThumb(request, defaultDeps())
  },
}
