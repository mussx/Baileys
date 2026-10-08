import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type { UserFacingSocketConfig } from '../Types'
import { makeCommunitiesSocket } from './communities'

// export the last socket layer
const makeWASocket = (config: UserFacingSocketConfig) => {
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
