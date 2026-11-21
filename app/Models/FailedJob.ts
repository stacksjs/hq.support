import FailedJob from '@stacksjs/defaults/app/Models/FailedJob.ts'
import { extendModel } from '@stacksjs/orm'

export default extendModel(FailedJob, {
  dashboard: {
    label: 'Failed jobs',
    highlight: true,
    columns: ['queue', 'connection', 'attempts', 'failed_at'],
    actions: [],
    writes: [],
  },
  attributes: {
    payload: { ...FailedJob.attributes.payload, hidden: true },
    exception: { ...FailedJob.attributes.exception, hidden: true },
  },
})
