// A fake CoilShift app for testing a panel off the car with `node --test`: the parent window that speaks the bridge
// (README "Panels"), and a small DOM, so a panel's page script runs unchanged and nothing but node is needed.
//
//   const host = createHost({ permissions: ['settings.read'], settings: [...], data: { 'status.json': '{}' } })
//   const page = host.load(['panel/csdk-panel.js', 'panel/panel.js'])    // runs them in a context
//   await host.settle()                                                            // let the panel's requests finish
//   host.calls                                                                      // every request the panel made
//
// The host answers like the app does: a method the manifest's permissions do not allow is {code: "forbidden"}, a
// setting outside the panel's scope is {code: "out_of_scope"}, a secret is {set: bool} and never its value, and a
// message is answered only to the window it came from.
import fs from 'node:fs'
import vm from 'node:vm'

// Values the panel's context made have that context's prototypes; this is what assert.deepEqual can compare.
export const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const METHOD_PERMISSION = {
  'settings.get': 'settings.read',
  'settings.set': 'settings.write',
  status: 'status',
  'events.subscribe': 'events',
  'data.get': 'data',
}
const OPEN_METHODS = new Set(['theme', 'fonts'])
const DATA_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/

class TextNode {
  constructor(text) {
    this.nodeType = 3
    this.text = String(text)
  }
  get textContent() {
    return this.text
  }
}

export class Element {
  constructor(tag, document) {
    this.nodeType = 1
    this.tagName = tag.toUpperCase()
    this.ownerDocument = document
    this.attributes = {}
    this.children = []
    this.listeners = {}
    this.style = {}
    this.parentNode = null
    this.value = ''
    this.disabled = false
    this.checked = false
    this.innerHTML = ''
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }
  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null
  }
  removeAttribute(name) {
    delete this.attributes[name]
  }
  get id() {
    return this.attributes.id ?? ''
  }
  set id(value) {
    this.attributes.id = String(value)
  }
  get className() {
    return this.attributes.class ?? ''
  }
  set className(value) {
    this.attributes.class = String(value)
  }
  get classList() {
    const element = this
    const names = () => element.className.split(/\s+/).filter(Boolean)
    return {
      add: (...add) => (element.className = [...new Set([...names(), ...add])].join(' ')),
      remove: (...drop) => (element.className = names().filter((name) => !drop.includes(name)).join(' ')),
      contains: (name) => names().includes(name),
      toggle: (name, force) => {
        const has = names().includes(name)
        const want = force ?? !has
        if (want && !has) element.className = [...names(), name].join(' ')
        if (!want && has) element.className = names().filter((candidate) => candidate !== name).join(' ')
        return want
      },
    }
  }
  appendChild(child) {
    return this.append(child)
  }
  append(...kids) {
    for (const kid of kids) {
      if (kid === null || kid === undefined || kid === false) continue
      const node = typeof kid === 'object' ? kid : new TextNode(kid)
      node.parentNode = this
      this.children.push(node)
    }
  }
  replaceChildren(...kids) {
    this.children = []
    this.innerHTML = ''
    this.append(...kids)
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this)
  }
  get textContent() {
    return this.children.map((child) => child.textContent).join('')
  }
  set textContent(text) {
    this.children = []
    this.innerHTML = ''
    if (text !== '') this.append(String(text))
  }
  addEventListener(type, listener) {
    ;(this.listeners[type] ??= []).push(listener)
  }
  removeEventListener(type, listener) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((candidate) => candidate !== listener)
  }
  dispatch(type, extra = {}) {
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...extra }
    for (const listener of this.listeners[type] ?? []) listener(event)
  }
  click() {
    if (!this.disabled) this.dispatch('click')
  }
  // Types into a field the way a person does: the value, then the input event.
  type(text) {
    this.value = text
    this.dispatch('input')
    this.dispatch('change')
  }
  descendants() {
    return this.children.flatMap((child) => (child.nodeType === 1 ? [child, ...child.descendants()] : []))
  }
  find(predicate) {
    return this.descendants().find(predicate) ?? null
  }
  findAll(predicate) {
    return this.descendants().filter(predicate)
  }
  byText(text) {
    return this.find((element) => element.children.length > 0 && element.children.every((c) => c.nodeType === 3) && element.textContent === text)
  }
  byLabel(label) {
    return this.find((element) => element.attributes['aria-label'] === label)
  }
}

export class Document {
  constructor() {
    this.documentElement = new Element('html', this)
    this.head = new Element('head', this)
    this.body = new Element('body', this)
    this.documentElement.append(this.head, this.body)
    const root = new Element('div', this)
    root.id = 'root'
    this.body.append(root)
  }
  createElement(tag) {
    return new Element(tag, this)
  }
  createElementNS(_namespace, tag) {
    const element = new Element(tag, this)
    element.tagName = tag.toUpperCase()
    return element
  }
  createTextNode(text) {
    return new TextNode(text)
  }
  getElementById(id) {
    return this.documentElement.find((element) => element.id === id)
  }
}

// What a settings view of the app looks like for the panel: the host keeps the stored value, and shows a secret as
// {set}, never as its value.
function view(setting) {
  const { value, secret, ...rest } = setting
  return { ...rest, value: setting.type === 'secret' ? { set: Boolean(secret) } : value }
}

export function createHost(options = {}) {
  const permissions = new Set(options.permissions ?? [])
  const settings = (options.settings ?? []).map((setting) => ({ ...setting }))
  const data = { ...(options.data ?? {}) }
  const calls = []
  const timers = []
  const messageListeners = []
  const answers = options.answers ?? {}
  let status = options.status ?? { state: 'ok' }
  let theme = options.theme ?? 'night'
  const fonts = options.fonts ?? 'http://127.0.0.1:29942/fonts.css'
  let subscribed = false

  const document = new Document()
  const parent = {
    postMessage(message, targetOrigin) {
      const sent = plain(message)
      calls.push({ message: sent, targetOrigin })
      handle(sent, targetOrigin)
    },
  }
  const stranger = { postMessage() {} }

  const window = {
    document,
    parent,
    addEventListener: (type, listener) => type === 'message' && messageListeners.push(listener),
    removeEventListener: (type, listener) => {
      const at = messageListeners.indexOf(listener)
      if (type === 'message' && at >= 0) messageListeners.splice(at, 1)
    },
    setTimeout: (fn, ms) => timers.push({ fn, ms, interval: false, live: true }),
    clearTimeout: (id) => {
      if (timers[id - 1]) timers[id - 1].live = false
    },
    setInterval: (fn, ms) => timers.push({ fn, ms, interval: true, live: true }),
    clearInterval: (id) => {
      if (timers[id - 1]) timers[id - 1].live = false
    },
    console,
    TextEncoder,
  }
  window.window = window
  window.self = window

  function deliver(message, source = parent) {
    for (const listener of [...messageListeners]) listener({ data: message, source, origin: 'null' })
  }

  async function handle(message, targetOrigin) {
    const reply = (body) => deliver({ csdk: 1, id: message.id, ...body })
    if (targetOrigin !== '*') return reply({ error: { code: 'bad_origin', message: 'target origin must be *' } })
    if (!message || message.csdk !== 1 || typeof message.method !== 'string') return
    const { method, params = {} } = message
    if (!OPEN_METHODS.has(method) && !permissions.has(METHOD_PERMISSION[method])) {
      return reply({ error: { code: 'forbidden', message: `${method} needs the ${METHOD_PERMISSION[method]} permission` } })
    }
    if (method in answers) {
      try {
        return reply({ result: await answers[method](params) })
      } catch (error) {
        return reply({ error: { code: error.code ?? 'failed', message: error.message } })
      }
    }
    switch (method) {
      case 'settings.get':
        return reply({ result: settings.map(view) })
      case 'settings.set': {
        const setting = settings.find((candidate) => candidate.id === params.id)
        if (!setting) return reply({ error: { code: 'out_of_scope', message: `${params.id} is not a setting of this panel` } })
        if (setting.type === 'secret') setting.secret = params.value !== ''
        else setting.value = params.value
        if (subscribed) deliver({ csdk: 1, event: 'settings' })
        return reply({ result: { ok: true } })
      }
      case 'status':
        return reply({ result: status })
      case 'events.subscribe':
        subscribed = true
        return reply({ result: {} })
      case 'data.get':
        if (!DATA_NAME.test(params.name ?? '')) return reply({ error: { code: 'bad_name', message: 'not a valid data name' } })
        return params.name in data
          ? reply({ result: data[params.name] })
          : reply({ error: { code: 'not_found', message: `${params.name} does not exist` } })
      case 'theme':
        return reply({ result: { mode: theme } })
      case 'fonts':
        return reply({ result: fonts })
      default:
        return reply({ error: { code: 'unknown_method', message: method } })
    }
  }

  return {
    window,
    document,
    calls,
    stranger,
    settings,
    // The requests a panel made, by method.
    requests: (method) => calls.map((call) => call.message).filter((message) => message.method === method),
    setStatus: (next) => (status = next),
    setTheme: (mode) => (theme = mode),
    setData: (name, text) => (data[name] = text),
    // The app tells the panel something changed (it does so only after events.subscribe).
    push: (event) => deliver({ csdk: 1, event }),
    // Any message from the app's window, as it is: a panel must ignore what is not the bridge.
    raw: (message) => deliver(message),
    // A message from any window but the app's: a panel must not act on it.
    spoof: (message) => deliver(message, stranger),
    subscribed: () => subscribed,
    // Runs the files in one context whose globals are this window, as the sandboxed iframe would.
    load(files) {
      const context = vm.createContext(window)
      for (const file of files) vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file })
      return context
    },
    run: (context, code) => vm.runInContext(code, context),
    // Lets every request in flight, and what the panel does with its answers, finish.
    async settle(rounds = 6) {
      for (let round = 0; round < rounds; round++) await new Promise((resolve) => setImmediate(resolve))
    },
    // Fires the intervals a panel armed, once each (a poll), and lets it finish.
    async tick() {
      for (const timer of timers.filter((candidate) => candidate.live && candidate.interval)) timer.fn()
      await this.settle()
    },
    timers,
  }
}
