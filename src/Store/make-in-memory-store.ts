import { createRequire } from 'node:module'
import type KeyedDB from '@adiwajshing/keyed-db'
import type { Comparable } from '@adiwajshing/keyed-db/lib/Types'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { Logger } from 'pino'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type makeWASocket from '../Socket/index'
import type { BaileysEventEmitter, Chat, ConnectionState, Contact, GroupMetadata, PresenceData, WAMessage, WAMessageCursor, WAMessageKey } from '../Types'
import { toNumber, updateMessageWithReaction, updateMessageWithReceipt } from '../Utils'
import { areJidsSameUser, jidNormalizedUser } from '../WABinary'
import makeOrderedDictionary from './make-ordered-dictionary'

type WASocket = ReturnType<typeof makeWASocket>

export const waChatKey = (pin: boolean) => ({
	key: (c: Chat) => (pin ? (c.pinned ? '1' : '0') : '') + (c.archived ? '0' : '1') + (c.conversationTimestamp ? c.conversationTimestamp.toString(16).padStart(8, '0') : '') + c.id,
	compare: (k1: string, k2: string) => k2.localeCompare (k1)
})

export const waMessageID = (m: WAMessage) => m.key.id || ''

export type BaileysInMemoryStoreConfig = {
	chatKey?: Comparable<Chat, string>
	logger?: Logger
}

const makeMessagesDictionary = () => makeOrderedDictionary(waMessageID)

const makeInMemoryStore = (
	{ logger: _logger, chatKey }: BaileysInMemoryStoreConfig
) => {
	const logger = _logger || DEFAULT_CONNECTION_CONFIG.logger.child({ stream: 'in-mem-store' })
	chatKey = chatKey || waChatKey(true)
	// keyed-db is CJS; load it via createRequire so this works in the ESM build
	const KeyedDBImpl = createRequire(import.meta.url)('@adiwajshing/keyed-db').default as typeof KeyedDB

	const chats = new KeyedDBImpl<Chat, string>(chatKey, (c: Chat) => c.id!)
	const messages: { [_: string]: ReturnType<typeof makeMessagesDictionary> } = { }
	const contacts: { [_: string]: Contact } = { }
	const groupMetadata: { [_: string]: GroupMetadata } = { }
	const presences: { [id: string]: { [participant: string]: PresenceData } } = { }
	const state: ConnectionState = { connection: 'close' }

	const assertMessageList = (jid: string) => {
		if(!messages[jid]) {
			messages[jid] = makeMessagesDictionary()
		}

		return messages[jid]
	}

	const contactsUpsert = (newContacts: Contact[]) => {
		const oldContacts = new Set(Object.keys(contacts))
		for(const contact of newContacts) {
			oldContacts.delete(contact.id)
			contacts[contact.id] = Object.assign(
				contacts[contact.id] ?? {},
				contact
			)
		}

		return oldContacts
	}

	/**
	 * binds to a BaileysEventEmitter.
	 * It listens to all events and constructs a state that you can query accurate data from.
	 * Eg. can use the store to fetch chats, contacts, messages etc.
	 * @param ev typically the event emitter from the socket connection
	 */
	const bind = (ev: BaileysEventEmitter) => {
		ev.on('connection.update', update => {
			Object.assign(state, update)
		})

		ev.on('messaging-history.set', ({
			chats: newChats,
			contacts: newContacts,
			messages: newMessages,
			isLatest
		}) => {
			if(isLatest) {
				chats.clear()

				for(const id in messages) {
					delete messages[id]
				}
			}

			const chatsAdded = chats.insertIfAbsent(...newChats).length
			logger.debug({ chatsAdded }, 'synced chats')

			const oldContacts = contactsUpsert(newContacts)
			for(const jid of oldContacts) {
				delete contacts[jid]
			}

			logger.debug({ deletedContacts: oldContacts.size, newContacts }, 'synced contacts')

			for(const msg of newMessages) {
				const jid = msg.key.remoteJid!
				const list = assertMessageList(jid)
				list.upsert(msg, 'prepend')
			}

			logger.debug({ messages: newMessages.length }, 'synced messages')
		})

		ev.on('contacts.update', updates => {
			for(const update of updates) {
				const contact = contacts[update.id!]
				if(contact) {
					Object.assign(contact, update)
				} else {
					logger.debug({ update }, 'got update for non-existant contact')
				}
			}
		})
		ev.on('chats.upsert', newChats => {
			chats.upsert(...newChats)
		})
		ev.on('chats.update', updates => {
			for(let update of updates) {
				const result = chats.update(update.id!, chat => {
					if(update.unreadCount! > 0) {
						update = { ...update }
						update.unreadCount = (chat.unreadCount || 0) + update.unreadCount!
					}

					Object.assign(chat, update)
				})
				if(!result) {
					logger.debug({ update }, 'got update for non-existant chat')
				}
			}
		})
		ev.on('presence.update', ({ id, presences: update }) => {
			presences[id] = presences[id] || {}
			Object.assign(presences[id], update)
		})
		ev.on('chats.delete', deletions => {
			for(const item of deletions) {
				chats.deleteById(item)
			}
		})
		ev.on('messages.upsert', ({ messages: newMessages, type }) => {
			switch (type) {
			case 'append':
			case 'notify':
				for(const msg of newMessages) {
					const jid = jidNormalizedUser(msg.key.remoteJid!)
					const list = assertMessageList(jid)
					list.upsert(msg, 'append')

					if(type === 'notify') {
						if(!chats.get(jid)) {
							ev.emit('chats.upsert', [
								{
									id: jid,
									conversationTimestamp: toNumber(msg.messageTimestamp),
									unreadCount: 1
								}
							])
						}
					}
				}

				break
			}
		})
		ev.on('messages.update', updates => {
			for(const { update, key } of updates) {
				const list = assertMessageList(key.remoteJid!)
				const result = list.updateAssign(key.id!, update)
				if(!result) {
					logger.debug({ update }, 'got update for non-existent message')
				}
			}
		})
		ev.on('messages.delete', item => {
			if('all' in item) {
				const list = messages[item.jid]
				list?.clear()
			} else {
				const jid = item.keys[0]?.remoteJid
				const list = jid ? messages[jid] : undefined
				if(list) {
					const idSet = new Set(item.keys.map(k => k.id))
					list.filter(m => !idSet.has(m.key.id))
				}
			}
		})

		ev.on('groups.update', updates => {
			for(const update of updates) {
				const id = update.id!
				if(groupMetadata[id]) {
					Object.assign(groupMetadata[id], update)
				} else {
					logger.debug({ update }, 'got update for non-existant group metadata')
				}
			}
		})

		ev.on('group-participants.update', ({ id, participants, action }) => {
			const metadata = groupMetadata[id]
			if(metadata) {
				switch (action) {
				case 'add':
					metadata.participants.push(...participants)
					break
				case 'demote':
				case 'promote':
					for(const participant of metadata.participants) {
						if(participants.some(p => areJidsSameUser(p.id, participant.id))) {
							participant.isAdmin = action === 'promote'
						}
					}

					break
				case 'remove':
					metadata.participants = metadata.participants.filter(p => !participants.some(pp => areJidsSameUser(pp.id, p.id)))
					break
				}
			}
		})

		ev.on('message-receipt.update', updates => {
			for(const { key, receipt } of updates) {
				const obj = messages[key.remoteJid!]
				const msg = obj?.get(key.id!)
				if(msg) {
					updateMessageWithReceipt(msg, receipt)
				}
			}
		})

		ev.on('messages.reaction', (reactions) => {
			for(const { key, reaction } of reactions) {
				const obj = messages[key.remoteJid!]
				const msg = obj?.get(key.id!)
				if(msg) {
					updateMessageWithReaction(msg, reaction)
				}
			}
		})
	}

	const toJSON = () => ({
		chats,
		contacts,
		messages
	})

	const fromJSON = (json: { chats: Chat[], contacts: { [id: string]: Contact }, messages: { [id: string]: WAMessage[] } }) => {
		chats.upsert(...json.chats)
		contactsUpsert(Object.values(json.contacts))
		for(const jid in json.messages) {
			const list = assertMessageList(jid)
			for(const msg of json.messages[jid] || []) {
				list.upsert(proto.WebMessageInfo.fromObject(msg) as WAMessage, 'append')
			}
		}
	}


	return {
		chats,
		contacts,
		messages,
		groupMetadata,
		state,
		presences,
		bind,
		/** loads messages from the store, if not found -- uses the legacy connection */
		loadMessages: async(jid: string, count: number, cursor: WAMessageCursor) => {
			const list = assertMessageList(jid)
			const mode = !cursor || 'before' in cursor ? 'before' : 'after'
			const cursorKey = !!cursor ? ('before' in cursor ? cursor.before : cursor.after) : undefined
			const cursorValue = cursorKey ? list.get(cursorKey.id!) : undefined

			let messages: WAMessage[]
			if(list && mode === 'before' && (!cursorKey || cursorValue)) {
				if(cursorValue) {
					const msgIdx = list.array.findIndex(m => m.key.id === cursorKey?.id)
					messages = list.array.slice(0, msgIdx)
				} else {
					messages = list.array
				}

				const diff = count - messages.length
				if(diff < 0) {
					messages = messages.slice(-count) // get the last X messages
				}
			} else {
				messages = []
			}

			return messages
		},
		loadMessage: async(jid: string, id: string) => messages[jid]?.get(id),
		mostRecentMessage: async(jid: string) => {
			const message: WAMessage | undefined = messages[jid]?.array.slice(-1)[0]
			return message
		},
		fetchImageUrl: async(jid: string, sock: WASocket | undefined) => {
			const contact = contacts[jid]
			if(!contact) {
				return sock?.profilePictureUrl(jid)
			}

			if(typeof contact.imgUrl === 'undefined') {
				contact.imgUrl = await sock?.profilePictureUrl(jid)
			}

			return contact.imgUrl
		},
		fetchGroupMetadata: async(jid: string, sock: WASocket | undefined) => {
			if(!groupMetadata[jid]) {
				const metadata = await sock?.groupMetadata(jid)
				if(metadata) {
					groupMetadata[jid] = metadata
				}
			}

			return groupMetadata[jid]
		},
		fetchMessageReceipts: async({ remoteJid, id }: WAMessageKey) => {
			const list = messages[remoteJid!]
			const msg = list?.get(id!)
			return msg?.userReceipt
		},
		toJSON,
		fromJSON,
		writeToFile: (path: string) => {
			writeFileSync(path, JSON.stringify(toJSON()))
		},
		readFromFile: (path: string) => {
			if(existsSync(path)) {
				logger.debug({ path }, 'reading from file')
				const jsonStr = readFileSync(path, { encoding: 'utf-8' })
				const json = JSON.parse(jsonStr)
				fromJSON(json)
			}
		}
	}
}

export default makeInMemoryStore
