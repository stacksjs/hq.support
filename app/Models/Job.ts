import { extendModel } from '@stacksjs/orm'
import Job from '@stacksjs/defaults/app/Models/Job.ts'

export default extendModel(Job, { traits: { useSeeder: false }, dashboard: { access: false } })
