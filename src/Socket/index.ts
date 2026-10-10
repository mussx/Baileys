import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type { UserFacingSocketConfig } from '../Types'
import { makeCommunitiesSocket } from './communities'

// Banner MUSSX BAILEYS — sekali per proses, gradient truecolor tanpa dep tambahan
const printMussxBanner = () => {
	const g = globalThis as Record<string, unknown>
	if (g.__mussxBannerShown) return
	g.__mussxBannerShown = true

	const hexToRgb = (hex: string): [number, number, number] => [
		parseInt(hex.slice(1, 3), 16),
		parseInt(hex.slice(3, 5), 16),
		parseInt(hex.slice(5, 7), 16)
	]
	// gradient horizontal per karakter (ANSI 24-bit): cyan -> fuchsia
	const gradient = (text: string, from = '#22d3ee', to = '#e879f9') => {
		const [r1, g1, b1] = hexToRgb(from)
		const [r2, g2, b2] = hexToRgb(to)
		const chars = [...text]
		const last = Math.max(chars.length - 1, 1)
		return (
			chars
				.map((ch, i) => {
					const t = i / last
					const r = Math.round(r1 + (r2 - r1) * t)
					const gg = Math.round(g1 + (g2 - g1) * t)
					const b = Math.round(b1 + (b2 - b1) * t)
					return `\x1b[38;2;${r};${gg};${b}m${ch}`
				})
				.join('') + '\x1b[0m'
		)
	}

	const dim = '\x1b[2m'
	const bright = '\x1b[97m'
	const bold = '\x1b[1m'
	const reset = '\x1b[0m'
	const edge = '\x1b[38;2;129;140;248m'
	// rata tengah mengikuti lebar box (44 kolom)
	const center = (plain: string, width = 44) =>
		' '.repeat(Math.max(0, Math.floor((width - [...plain].length) / 2)))
	console.log(
		`\n${center('M U S S X')}${bold}${gradient('M U S S X')}\n` +
			`${center('B A I L E Y S  v7.0.0-rc20')}${bold}${gradient('B A I L E Y S')}${reset}  ${dim}v7.0.0-rc20${reset}\n` +
			`${center('─────────────────────────────')}${dim}─────────────────────────────${reset}\n` +
			`  ${gradient('✔ mussx-baileys ready')}\n` +
			`${edge}  ┌────────────────────────────────────────┐${reset}\n` +
			`${edge}  │${reset}  ${gradient('✦ MUSSX BAILEYS ✦')}\n` +
			`${edge}  │${reset}  ${dim}Owner :${reset} ${bright}MussX${reset}\n` +
			`${edge}  │${reset}  ${dim}WA    :${reset} ${bright}wa.me/6287840535460${reset}\n` +
			`${edge}  │${reset}  ${dim}Repo  :${reset} ${bright}github.com/mussx/Baileys${reset}\n` +
			`${edge}  └────────────────────────────────────────┘${reset}\n` +
			`  ${dim}© 2026 MussX${reset}\n`
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
