// HTTP Server Request Handler
import Busboy from 'busboy'
import Stripe from 'stripe'
import constants from './constants.js'
import cookie from 'cookie'
import doNotCache from 'do-not-cache'
import escapeHTML from 'escape-html'
import formatDate from './format-date.js'
import fs from 'fs'
import grayMatter from 'gray-matter'
import html from './html.js'
import httpHash from 'http-hash'
import markdown from 'kemarkdown'
import parseURL from 'url-parse'
import path from 'path'
import querystring from 'querystring'
import readEnvironment from './environment.js'
import runParallel from 'run-parallel'
import semver from 'semver'
import send from 'send'
import simpleConcatLimit from 'simple-concat-limit'
import yaml from 'js-yaml'

const environment = readEnvironment()
const stripe = new Stripe(environment.STRIPE_SECRET_KEY)

const about = markdown(fs.readFileSync('about.md', 'utf8'))
const agreement = (() => {
  const { content: markdown, data: { version, title, description } } = grayMatter(fs.readFileSync('agreement.md'))
  return { version, title, description, markdown }
})()

const versions = fs.readdirSync(path.join(environment.DIRECTORY, 'versions'))
  .filter(semver.valid)
  .sort(semver.rcompare)
const latestVersion = versions.filter(v => semver.prerelease(v) === null)[0]

// Router

const routes = httpHash()

routes.set('/', serveHomepage)
routes.set('/pay', servePay)
routes.set('/agree', serveAgree)
routes.set('/privacy', servePrivacy)
routes.set('/stripe-webhook', serveStripeWebhook)
routes.set('/versions/:version', requireCookie(serveVersion))

if (!environment.production) {
  routes.set('/internal-error', (request, response) => {
    serve500(request, response, new Error('test error'))
  })
}

for (const file of [
  'ads.txt',
  'styles.css',
  'normalize.css',
  'credits.txt',
  'security.txt',
  'logo.svg',
  'logo-on-white-100.png'
]) {
  routes.set(`/${file}`, (request, response) => {
    send(request, file).pipe(response)
  })
}

// HTTP Request Handler

export default (request, response) => {
  const parsed = request.parsed = parseURL(request.url, true)
  const pathname = request.pathname = parsed.pathname
  request.query = parsed.query
  const { handler, params } = routes.get(pathname)
  if (handler) {
    request.parameters = params
    return handler(request, response)
  }
  serve404(request, response)
}

// Partials

function meta ({
  title = constants.website,
  description = constants.slogan
}) {
  let returned = html`
<meta charset=UTF-8>
<meta name=viewport content="width=device-width, initial-scale=1">
  `
  if (description) {
    returned += html`
<meta name="description" content="${escapeHTML(description)}">
    `
  }
  if (title && description) {
    returned += html`
<meta name="twitter:card" content="summary">
<meta name="twitter:description" content="${escapeHTML(description)}">
<meta name="twitter:image" content="${process.env.BASE_HREF}/logo-on-white-100.png">
<meta name="twitter:site" content="@${constants.twitter}">
<meta name="twitter:title" content="${escapeHTML(title)}">
<meta name="og:type" content="website">
<meta name="og:title" content="${escapeHTML(title)}">
<meta name="og:description" content="${escapeHTML(description)}">
<meta name="og:image" content="${process.env.BASE_HREF}/logo-on-white-100.png">
<meta name="og:site" content="${escapeHTML(constants.website)}">
    `
  }
  returned += html`
<link href=/normalize.css rel=stylesheet>
<link href=/styles.css rel=stylesheet>
  `
  return returned
}

const header = `
<header role=banner>
  <a href=/><img src=/logo.svg id=logo alt=logo></a>
  <h1>${constants.website}</h1>
  <p class=slogan>${escapeHTML(constants.slogan)}</p>
</header>
`

const footer = `
<footer role=contentinfo>
  <a class=spaced href=/>About</a>
  <a class=spaced href=/agree>Agreement</a>
  <a class=spaced href=mailto:${constants.support}>E-Mail</a>
  <a class=spaced href=/credits.txt>Credits</a>
</footer>
`

const nav = `
<nav role=navigation>
</nav>
`

// Routes

function serveHomepage (request, response) {
  if (request.method !== 'GET') return serve405(request, response)
  doNotCache(response)
  response.setHeader('Content-Type', 'text/html')
  response.end(html`
<!doctype html>
<html lang=en-US>
  <head>
    ${meta({
      title: constants.website,
      description: constants.slogan
    })}
    <title>${constants.website}</title>
  </head>
  <body>
    ${nav}
    ${header}
    <main role=main>
      ${about}
    </main>
    ${footer}
  </body>
</html>
  `)
}

function serveAgree (request, response) {
  const { method } = request
  if (method === 'POST') {
    let parser
    let valid = false
    try {
      parser = new Busboy({
        headers: request.headers,
        limits: {
          fieldNameSize: 'version'.length,
          fields: 1,
          fieldSizeLimit: 'YY-MM-DD'.length,
          parts: 1
        }
      })
        .once('field', (name, value, truncated, encoding, mime) => {
          if (name === 'version' && value === agreement.version) {
            valid = true
          }
        })
        .once('finish', () => {
          if (valid) {
            const expires = new Date(
              Date.now() + (30 * 24 * 60 * 60 * 1000)
            )
            setCookie(response, agreement.version, expires)
            const location = request.query.destination || '/'
            serve303(request, response, location)
          } else {
            serveAgreeForm(request, response)
          }
        })
      request.pipe(parser)
    } catch (error) {
      response.statusCode = 400
      response.end()
    }
  } else if (method === 'GET') {
    serveAgreeForm(request, response)
  } else {
    serve405(request, response)
  }
}

function serveAgreeForm (request, response) {
  doNotCache(response)
  clearCookie(response)
  response.setHeader('Content-Type', 'text/html')
  response.end(html`
<!doctype html>
<html lang=en-US>
  <head>
    ${meta({
      title: agreement.title,
      description: agreement.description
    })}
    <title>${escapeHTML(agreement.title)}</title>
  </head>
  <body>
    ${header}
    <main role=main>
      <form id=passwordForm method=post>
        <input type=hidden name=version value=${agreement.version}>
        <h2>${escapeHTML(agreement.title)}</h2>
        <p id=version>Last Updated ${formatDate(agreement.version)}</p>
        ${markdown(agreement.markdown)}
        <button type=submit>Agree</button>
      </form>
    </main>
    ${footer}
  </body>
</html>
  `)
}

function servePay (request, response) {
  serve404(request, response)
}

function serveVersion (request, response) {
  const { version } = request.parameters
  request.log.info(request.parameters, 'parameters')
  runParallel({
    prompts: done => {
      const file = path.join(environment.DIRECTORY, 'versions', version, 'prompts.yml')
      fs.readFile(file, 'utf8', (error, data) => {
        if (error) return done(error)
        let parsed
        try {
          parsed = yaml.load(data, { schema: yaml.JSON_SCHEMA })
        } catch (error) {
          return done(error)
        }
        done(null, parsed)
      })
    },
    terms: readTemplate('terms'),
    order: readTemplate('order')
  }, (error, results) => {
    if (error) return serve500(request, response, error)
    response.setHeader('Content-Type', 'text/html')
    response.end(html`
<!doctype html>
<html lang=en-US>
  <head>
    ${meta({
      title: `${constants.website} ${version}`,
      description: constants.slogan
    })}
    <title>${constants.website}</title>
  </head>
  <body>
    ${nav}
    ${header}
    <main role=main>
      <h2>Version ${version}</h2>
      <h3>Prompts</h3>
      <pre>${escapeHTML(results.prompts)}</pre>
      <h3>Order</h3>
      <pre>${escapeHTML(results.order)}</pre>
      <h3>Terms</h3>
      <pre>${escapeHTML(results.terms)}</pre>
    </main>
    ${footer}
  </body>
</html>
    `)
  })

  function readTemplate (basename) {
    return done => {
      const file = path.join(environment.DIRECTORY, 'versions', version, `${basename}.md`)
      fs.readFile(file, 'utf8', done)
    }
  }
}

function servePrivacy (request, response) {
  serve404(request, response)
}

function serveStripeWebhook (request, response) {
  simpleConcatLimit(request, 32768, (error, buffer) => {
    if (error) {
      request.log.error(error)
      response.statusCode = 413
      return response.end()
    }

    let event
    try {
      event = stripe.webhooks.constructEvent(
        // constructEvent wants the raw, unparsed JSON request body.
        buffer.toString(),
        request.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      )
    } catch (error) {
      request.log.warn(error)
      response.statusCode = 400
      return response.end()
    }

    const { id, type } = event
    request.log.info({ id, type }, 'Stripe webhook event')

    rejectEvent()
  })

  function acceptEvent () {
    response.statusCode = 200
    response.end()
  }

  function rejectEvent () {
    response.statusCode = 400
    response.end()
  }
}

function serve404 (request, response) {
  response.statusCode = 404
  const title = 'Not Found'
  response.setHeader('Content-Type', 'text/html')
  response.end(`
<!doctype html>
<html lang=en-US>
  <head>
    ${meta({})}
    <title>${title}</title>
  </head>
  <body>
    ${nav}
    ${header}
    <main role=main>
      <h2>${title}</h2>
      <p>The page you tried to visit doesn’t exist on this site.</p>
    </main>
    ${footer}
  </body>
</html>
  `)
}

function serve500 (request, response, error) {
  request.log.error(error)
  response.statusCode = 500
  const title = 'Internal Error'
  response.setHeader('Content-Type', 'text/html')
  response.end(html`
<!doctype html>
<html lang=en-US>
  <head>
    ${meta({})}
    <title>${title}</title>
  </head>
  <body>
    <main role=main>
      <h1>${title}</h1>
      <p>The server ran into an error.</p>
      <p>
        If you'd like, you can
        <a href=mailto:${constants.support}>e-mail support</a>,
        pasting in this unique support number:
        <code>${escapeHTML(request.id)}</code>
      </p>
    </main>
    ${footer}
  </body>
</html>
  `)
}

function serve405 (request, response) {
  response.statusCode = 405
  response.setHeader('Content-Type', 'text/plain')
  response.end('Method Not Allowed')
}

function serve303 (request, response, location) {
  response.statusCode = 303
  response.setHeader('Location', location)
  response.end()
}

function serve302 (request, response, location) {
  response.statusCode = 302
  response.setHeader('Location', location)
  response.end()
}

function requireCookie (handler) {
  return (request, response) => {
    const header = request.headers.cookie
    if (!header) return redirect()
    const parsed = cookie.parse(header)
    const version = parsed[constants.cookie]
    if (!version) return redirect()
    if (version !== agreement.version) return redirect()
    handler(request, response)

    function redirect () {
      const location = '/agree?' + querystring.stringify({
        destination: request.url
      })
      serve303(request, response, location)
    }
  }
}

function setCookie (response, value, expires) {
  response.setHeader(
    'Set-Cookie',
    cookie.serialize(constants.cookie, value, {
      expires,
      httpOnly: true,
      sameSite: 'strict',
      secure: environment.production
    })
  )
}

function clearCookie (response) {
  setCookie(response, '', new Date('1970-01-01'))
}
