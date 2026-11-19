"""Presentation-only quiet loading transform shared by inline and split mappers."""
import re

QUIET_STYLE = '''<style id="floodmapper-quiet-loading-20261119">
/* Keep request/readiness state and failure recovery; omit loading presentation. */
body:not([data-site-loader$="error"]):not([data-site-loader$="failed"]) #nwSiteLoader{display:none!important}
html body.nw-app-loading :is(#app,#topBanner){opacity:1!important;filter:none!important;animation:none!important}
#nwSiteLoader::before,#nwSiteLoader::after,.nw-loader-spinner,.nw-loader-progress,.flood-history-spinner,.download-btn-spinner{display:none!important;animation:none!important}
.flood-history-loading{display:none!important}
#stageSubText:empty,#floodFrameStatus:empty{display:none!important}
</style>'''

def patch_runtime_text(text):
    text = text.replace('if (state === "loading") message = "";',
        'if (state === "loading" || (state === "info" && /^Loading\\b/i.test(String(message || "")))) message = "";')
    for message in [
        'Loading forecast…', 'Loading modeled flood…', 'Loading modeled flood… Previous flood map shown.',
        'Loading observed history…', 'Loading observed history… Previous flood map shown.',
        'Loading the next flood map… Previous frame shown.', 'Loading flood map…',
        'Loading historical flood… Previous flood map and time shown.',
        'Measuring the selected flood frame…',
    ]:
        text = text.replace('"'+message+'"', '""')
    text = text.replace('<span>Available data</span><strong>Loading…</strong>',
                        '<span>Available data</span><strong>—</strong>')
    text = text.replace('Loading the selected tide-archive year...', 'Preparing export...')
    text = text.replace('Loading export tools...', 'Preparing export...')
    text = text.replace('<div class="flood-history-loading" role="status"><span class="flood-history-spinner" aria-hidden="true"></span><strong>Loading flood projections…</strong></div>',
                        '<div class="flood-history-loading" aria-hidden="true"></div>')
    return text

def patch_index_html(data):
    text = patch_runtime_text(data.decode('utf-8'))
    if 'id="floodmapper-quiet-loading-20261119"' not in text:
        assert text.count('</head>') == 1
        text = text.replace('</head>', QUIET_STYLE+'\n</head>')
    if 'data-floodmapper-loading-ui=' not in text:
        text, n = re.subn(r'<body\b', '<body data-floodmapper-loading-ui="quiet-20261119"', text, count=1)
        assert n == 1
    text = re.sub(r'(id="nwSiteLoader"[^>]*aria-label=")[^"]*(")', r'\1Map status\2', text)
    text = re.sub(r'(<p id="nwLoaderStatus"[^>]*>)[^<]*(</p>)', r'\1\2', text)
    text = re.sub(r'<div class="flood-history-loading" role="status">\s*<span class="flood-history-spinner" aria-hidden="true"></span>\s*<strong>Preparing this building’s flood profile…</strong>\s*<span>Loading the projection model only when you need it.</span>\s*</div>',
                  '<div class="flood-history-loading" aria-hidden="true"></div>', text)
    return text.encode('utf-8')

def patch_loading(data):
    if b'</head>' in data and b'<body' in data:
        return patch_index_html(data)
    return patch_runtime_text(data.decode('utf-8')).encode('utf-8')
