import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { listSkills } from '@/lib/skills/compose'

export const GET = withAuthenticatedApi(async () => {
  return { success: true, skills: listSkills() }
})
