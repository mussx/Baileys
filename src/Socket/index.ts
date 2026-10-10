import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type { UserFacingSocketConfig } from '../Types'
import { makeCommunitiesSocket } from './communities'

// Banner sekali per proses (global flag biar gak spam tiap reconnect)
const printMussxBanner = () => {
	const g = globalThis as Record<string, unknown>
	if (g.__mussxBannerShown) return
	g.__mussxBannerShown = true
	// ANSI: bright blue #7dd3fc, green, yellow, dim
	const bl = '\x1b[94m', gr = '\x1b[32m', yl = '\x1b[33m', dm = '\x1b[2m', wh = '\x1b[97m', rs = '\x1b[0m'
	console.log(
		`${bl}\n  ✦ MUSSX BAILEYS ✦${rs}  ${dm}── v7.0.0-rc16 ──${rs}\n` +
		`${bl}  ┌─────────────────────────────────────────┐${rs}\n` +
		`${bl}  │${rs}  ${yl}✦ ${bl}MUSSX BAILEYS${yl} ✦${rs}\n` +
		`${bl}  │${rs}  ${dm}Owner  :${rs} ${wh}MussX${rs}\n` +
		`${bl}  │${rs}  ${dm}WA     :${rs} ${gr}wa.me/6287840535460${rs}\n` +
		`${bl}  └─────────────────────────────────────────┘${rs}\n` +
		`${gr}  ✔ mussx-baileys ready${rs}\n` +
		`${dm}  © 2026 MussX${rs}\n`
	)
}

// export the last socket layer
const makeWASocket = (config: UserFacingSocketConfig) => {
	printMussxBanner()
	const newConfig = {
		...DEFAULT_CONNECTION_CONFIG,
		...config
	}

	const sock = makeCommunitiesSocket(newConfig)

	// Keepalive: ping presence tiap 90 detik biar koneksi gak "tidur" saat idle.
	// Tanpa ini, perintah pertama setelah bot idle lama jadi delay/gak dibales
	// (koneksi dingin), perintah berikutnya normal. Ping ini invisible:
	// gak ngirim pesan ke chat manapun, cuma jaga websocket tetep anget.
	let keepaliveTimer: NodeJS.Timeout | undefined
	const stopKeepalive = () => {
		if (keepaliveTimer) {
			clearInterval(keepaliveTimer)
			keepaliveTimer = undefined
		}
	}
	sock.ev.on('connection.update', ({ connection }) => {
		if (connection === 'open') {
			stopKeepalive()
			keepaliveTimer = setInterval(() => {
				sock.sendPresenceUpdate('available').catch(() => {
					// ping gagal: biar handler connection.update yang urus reconnect
				})
			}, 90_000)
		} else if (connection === 'close') {
			stopKeepalive()
		}
	})

	return sock
}

export default makeWASocket
