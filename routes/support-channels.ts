import { route } from '@stacksjs/router'
import { channelAction } from '../app/Actions/Support/ChannelAction'

route.get('/support/projects/{project}/channels', channelAction('list', 'GET')).middleware('auth')
route.post('/support/projects/{project}/channels', channelAction('save', 'POST')).middleware('auth').rateLimit(30, 'minute')
route.post('/support/projects/{project}/channels/{channel}', channelAction('save', 'POST')).middleware('auth')
route.post('/support/projects/{project}/channels/{channel}/verify', channelAction('verify', 'POST')).middleware('auth').rateLimit(10, 'minute')
route.post('/support/projects/{project}/channels/{channel}/disable', channelAction('disable', 'POST')).middleware('auth')
route.post('/support/projects/{project}/channels/{channel}/poll', channelAction('poll', 'POST')).middleware('auth').rateLimit(30, 'minute')
route.post('/support/projects/{project}/channel-conversations/{conversation}/messages', channelAction('reply', 'POST')).middleware('auth')
route.get('/support/projects/{project}/channel-deliveries', channelAction('deliveries', 'GET')).middleware('auth')
route.get('/support/projects/{project}/channel-deliveries/{delivery}', channelAction('delivery', 'GET')).middleware('auth')
route.post('/support/projects/{project}/channel-deliveries/{delivery}/reconcile', channelAction('reconcile', 'POST')).middleware('auth').rateLimit(30, 'minute')
route.post('/channels/{channel}/incoming', channelAction('incoming', 'POST')).skipCsrf().rateLimit(300, 'minute')
route.get('/channels/{channel}/incoming', channelAction('challenge', 'GET')).rateLimit(60, 'minute')
route.post('/channels/{channel}/deliveries/{delivery}/status', channelAction('status', 'POST')).skipCsrf().rateLimit(300, 'minute')
