/* eslint no-redeclare: "off", block-scoped-var: "off" */
var util = require('util'),
    _ = require('lodash'),
    esprima = require('esprima'),
    jsdom = require('jsdom'),
    htmlMinifier = require('html-minifier'),
    extendWithGettersAndSetters = require('../util/extendWithGettersAndSetters'),
    errors = require('../errors'),
    Text = require('./Text'),
    JavaScript = require('./JavaScript'),
    AssetGraph = require('../');

function Html(config) {
    if (typeof config.isFragment !== 'undefined') {
        this._isFragment = config.isFragment;
        config.isFragment = undefined;
    }

    this._templateReplacements = {};
    if (typeof config.text === 'string') {
        config.text = this._replaceTemplates(config.text);
    }

    Text.call(this, config);
}

util.inherits(Html, Text);

var isSensitiveByTagName = {
    pre: true,
    code: true,
    textarea: true,
    script: true,
    style: true
};

var isWhiteSpaceInsensitiveByTagName = {};

[
    '#document', 'html', 'body', 'head',
    'title', 'meta', 'link', 'style', 'script',
    'address', 'blockquote', 'div', 'dl', 'fieldset', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'noscript', 'ol', 'p', 'pre', 'table', 'ul',
    'dd', 'dt', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr'
].forEach(function (blockLevelTagName) {
    isWhiteSpaceInsensitiveByTagName[blockLevelTagName] = true;
});

function extractEncodingFromText(text) {
    var metaCharset;
    (text.match(/<meta[^>]+>/ig) || []).forEach(function (metaTagString) {
        if (/\bhttp-equiv=([\"\']|)\s*Content-Type\s*\1/i.test(metaTagString)) {
            var matchContent = metaTagString.match(/\bcontent=([\"\']|)\s*text\/html;\s*charset=([\w\-]*)\s*\1/i);
            if (matchContent) {
                metaCharset = matchContent[2];
            }
        } else {
            var matchSimpleCharset = metaTagString.match(/\bcharset=([\"\']|)\s*([\w\-]*)\s*\1/i);
            if (matchSimpleCharset) {
                metaCharset = matchSimpleCharset[2];
            }
        }
    });
    return metaCharset; // Will be undefined if not found
}

extendWithGettersAndSetters(Html.prototype, {
    contentType: 'text/html',

    supportedExtensions: ['.html', '.template', '.xhtml', '.shtml', '.ko'],

    isPretty: false,

    get encoding() {
        if (!this._encoding) {
            // An explicit encoding (Content-Type header, data: url charset, assetConfig) takes precedence, but if absent we should
            // look for a <meta http-equiv='Content-Type' ...> tag with a charset before falling back to the defaultEncoding (utf-8)
            if (typeof this._text === 'string') {
                this._encoding = extractEncodingFromText(this._text) || this.defaultEncoding;
            } else if (this._rawSrc) {
                this._encoding = extractEncodingFromText(this._rawSrc.toString('binary', 0, Math.min(1024, this._rawSrc.length))) || this.defaultEncoding;
            } else {
                this._encoding = this.defaultEncoding;
            }
        }
        return this._encoding;
    },

    set encoding(encoding) {
        // An intended side effect of getting this.parseTree before deleting this._rawSrc is that we're sure
        // that the raw source has been decoded into this._text before the original encoding is thrown away.
        var parseTree = this.parseTree;
        if (parseTree.head) {
            var existingMetaElements = parseTree.head.getElementsByTagName('meta'),
                contentTypeMetaElement;
            for (var i = 0 ; i < existingMetaElements.length ; i += 1) {
                var metaElement = existingMetaElements[i];
                if (metaElement.hasAttribute('charset') || /^content-type$/i.test(metaElement.getAttribute('http-equiv'))) {
                    contentTypeMetaElement = metaElement;
                    break;
                }
            }
            if (!contentTypeMetaElement) {
                contentTypeMetaElement = parseTree.createElement('meta');
                parseTree.head.insertBefore(contentTypeMetaElement, parseTree.head.firstChild);
                this.markDirty();
            }
            if (contentTypeMetaElement.hasAttribute('http-equiv')) {
                if ((contentTypeMetaElement.getAttribute('content') || '').toLowerCase() !== 'text/html; charset=' + encoding) {
                    contentTypeMetaElement.setAttribute('content', 'text/html; charset=' + encoding);
                    this.markDirty();
                }
            } else {
                // Simple <meta charset="...">
                if (contentTypeMetaElement.getAttribute('charset') !== encoding) {
                    contentTypeMetaElement.setAttribute('charset', encoding);
                    this.markDirty();
                }
            }
        }
        if (encoding !== this.encoding) {
            this._encoding = encoding;
            this.markDirty();
        }
    },

    unload: function () {
        Text.prototype.unload.call(this);
        this._templateReplacements = {};
    },

    get text() {
        var self = this,
            text = Object.keys(this._templateReplacements).reduce(function (text, key) {
                return text.replace(key, self._templateReplacements[key]);
            }, this.internalText);
        if (this.isMinified) {
            text = htmlMinifier.minify(text, {
                // https://github.com/kangax/html-minifier#options-quick-reference
                maxLineLength: Infinity,
                collapseWhitespace: true,
                conservativeCollapse: true, // We do our own, slightly more advanced whitespace collapsing before passing the doc to html-minifier
                collapseBooleanAttributes: true,
                removeEmptyAttributes: true,
                removeAttributeQuotes: true,
                // useShortDoctype: true, // Replaces any DOCTYPE with the HTML5 one.
                // removeOptionalTags: true, // Omits </head>, </body>, </html> etc. Too obtrusive?
                removeComments: true,
                removeScriptTypeAttributes: true,
                removeStyleLinkTypeAttributes: true,
                ignoreCustomComments: [
                    /^\s*\/?(?:ko|hz)(?:\s|$)/,
                    /^ASSETGRAPH DOCUMENT (?:START|END) MARKER$|^#|^\[if|^<!\[endif\]|^esi/
                ]
            });
        }
        return text;
    },

    get internalText() {
        if (typeof this._text !== 'string') {
            if (this._parseTree) {
                this._text = this.isFragment ? this._parseTree.innerHTML : jsdom.serializeDocument(this._parseTree);
            } else {
                this._text = this._replaceTemplates(this._getTextFromRawSrc());
            }
        }

        return this._text;
    },

    _replaceTemplates: function (text) {
        var self = this;
        // Replace templating tags like PHP, JSP, Underscore template syntax etc
        // They all use <>, which risks making the HTML invalid and JSDOM unable to parse it.
        return text.replace(/<([%\?])[^\1]*?\1>/g, function (match, sub1, offset) {
            var key = '⋖' + offset + '⋗';

            self._templateReplacements[key] = match;

            return key;
        });
    },

    set text(text) {
        this.unload();

        this._text = this._replaceTemplates(text);
        if (this.assetGraph) {
            this.populate();
        }
        this.markDirty();
    },

    get parseTree() {
        if (!this._parseTree) {
            var text = this.internalText;
            var isFragment = this.isFragment;
            var document;
            try {
                document = jsdom.jsdom(isFragment ? '<body>' + text + '</body>' : text, {
                    features: {
                        ProcessExternalResources: [],
                        FetchExternalResources: [],
                        QuerySelector: true
                    }
                });
            } catch (e) {
                var err = new errors.ParseError({message: 'Parse error in ' + this.urlOrDescription + '\n' + e.message, asset: this});
                if (this.assetGraph) {
                    this.assetGraph.emit('warn', err);
                } else {
                    throw err;
                }
            }
            if (isFragment) {
                // Install the properties of document on the HtmlBodyElement used as the parse tree:
                for (var propertyName in document) {
                    if (!(propertyName in document.body) && propertyName !== 'head') {
                        if (typeof document[propertyName] === 'function') {
                            document.body[propertyName] = document[propertyName].bind(document);
                        } else {
                            document.body[propertyName] = document[propertyName];
                        }
                    }
                }
                this._parseTree = document.body;
            } else {
                this._parseTree = document;
            }
        }
        return this._parseTree;
    },

    set parseTree(parseTree) {
        this.unload();
        this._parseTree = parseTree;
        this.markDirty();
    },

    get isFragment() {
        if (typeof this._isFragment === 'undefined' && this.isLoaded) {
            if (this._parseTree) {
                var document = this.parseTree;
                this._isFragment = !document.doctype && !document.body &&
                    document.getElementsByTagName('head').length === 0;
            } else {
                this._isFragment = !/<html/i.test(this.text);
            }
        }
        return this._isFragment;
    },

    set isFragment(isFragment) {
        this._isFragment = isFragment;
    },

    findOutgoingRelationsInParseTree: function () {
        var currentConditionalComments = [],
            outgoingRelations = Text.prototype.findOutgoingRelationsInParseTree.call(this);
        function addOutgoingRelation(outgoingRelation) {
            if (currentConditionalComments.length > 0) {
                outgoingRelation.conditionalComments = [].concat(currentConditionalComments);
            }
            outgoingRelations.push(outgoingRelation);
        }

        if (this.parseTree.documentElement && this.parseTree.documentElement.hasAttribute('manifest')) {
            addOutgoingRelation(new AssetGraph.HtmlCacheManifest({
                from: this,
                to: {
                    url: this.parseTree.documentElement.getAttribute('manifest')
                },
                node: this.parseTree.documentElement
            }));
        }
        var manifestFound = false;
        var queue = [this.parseTree];
        while (queue.length) {
            var node = queue.shift(),
                traverse = true;
            if (node.nodeType === node.ELEMENT_NODE) {
                for (var i = 0 ; i < node.attributes.length ; i += 1) {
                    var attribute = node.attributes[i];
                    if (/^on/i.test(attribute.nodeName)) {
                        addOutgoingRelation(new AssetGraph.HtmlInlineEventHandler({
                            from: this,
                            attributeName: attribute.nodeName,
                            to: new JavaScript({
                                isExternalizable: false,
                                serializationOptions: {
                                    semicolons: true,
                                    side_effects: false,
                                    newline: '',
                                    indent_level: 0
                                },
                                text: 'function bogus() {' + attribute.nodeValue + '}'
                            }),
                            node: node
                        }));
                    }
                }

                var nodeName = node.nodeName.toLowerCase();
                if (nodeName === 'script') {
                    var type = node.getAttribute('type');

                    if (!type || type === 'text/javascript') {
                        var src = node.getAttribute('src');
                        if (src) {
                            addOutgoingRelation(new AssetGraph.HtmlScript({
                                from: this,
                                to: {
                                    url: src
                                },
                                node: node
                            }));
                        } else {
                            addOutgoingRelation(new AssetGraph.HtmlScript({
                                from: this,
                                to: new (require('./JavaScript'))({
                                    sourceUrl: this.sourceUrl || this.url,
                                    text: node.firstChild ? node.firstChild.nodeValue : ''
                                }),
                                node: node
                            }));
                        }
                    } else if (type === 'text/html' || type === 'text/ng-template') {
                        addOutgoingRelation(new AssetGraph.HtmlInlineScriptTemplate({
                            from: this,
                            to: new Html({
                                isExternalizable: false,
                                text: node.innerHTML || ''
                            }),
                            node: node
                        }));
                    }
                } else if (nodeName === 'template') {
                    traverse = false;
                    addOutgoingRelation(new AssetGraph.HtmlTemplate({
                        from: this,
                        to: new Html({
                            isFragment: true,
                            isInline: true,
                            text: node.innerHTML || ''
                        }),
                        node: node
                    }));
                } else if (nodeName === 'style') {
                    addOutgoingRelation(new AssetGraph.HtmlStyle({
                        from: this,
                        to: new (require('./Css'))({
                            sourceUrl: this.sourceUrl || this.url,
                            text: node.firstChild ? node.firstChild.nodeValue : ''
                        }),
                        node: node
                    }));
                } else if (nodeName === 'link') {
                    if (node.hasAttribute('rel') && node.hasAttribute('href')) {
                        var rel = node.getAttribute('rel');
                        if (/(?:^| )stylesheet(?:$| )/i.test(rel)) {
                            addOutgoingRelation(new AssetGraph.HtmlStyle({
                                from: this,
                                to: {
                                    url: node.getAttribute('href')
                                },
                                node: node
                            }));
                        } else if (/(?:^| )(?:apple-touch-icon(?:-precomposed)?|icon)(?:$| )/i.test(rel)) { // Also catches rel="shortcut icon"
                            addOutgoingRelation(new AssetGraph.HtmlShortcutIcon({
                                from: this,
                                to: {
                                    url: node.getAttribute('href')
                                },
                                node: node
                            }));
                        } else if (/(?:^| )apple-touch-startup-image(?:$| )/i.test(rel)) {
                            addOutgoingRelation(new AssetGraph.HtmlAppleTouchStartupImage({
                                from: this,
                                to: {
                                    url: node.getAttribute('href')
                                },
                                node: node
                            }));
                        } else if (/(?:^| )alternate(?:$| )/i.test(rel)) {
                            var assetConfig = {
                                url: node.getAttribute('href')
                            };
                            if (node.hasAttribute('type')) {
                                assetConfig.contentType = node.getAttribute('type');
                            }
                            addOutgoingRelation(new AssetGraph.HtmlAlternateLink({
                                from: this,
                                to: assetConfig,
                                node: node
                            }));
                        } else if (/(?:^| )manifest(?:$| )/i.test(rel)) {
                            // Application Manifests
                            // See http://www.w3.org/TR/appmanifest/#using-a-link-element-to-link-to-a-manifest
                            if (!manifestFound) {
                                var assetConfig = {
                                    type: 'ApplicationManifest',
                                    url: node.getAttribute('href')
                                };
                                addOutgoingRelation(new AssetGraph.HtmlApplicationManifest({
                                    from: this,
                                    to: assetConfig,
                                    node: node
                                }));

                                manifestFound = true;
                            } else {
                                var err = new Error('Multiple ApplicationManifest relations. Only one per document is allowed. See http://www.w3.org/TR/appmanifest/#h-note4');
                                err.asset = this;
                                err.node = node;

                                this.assetGraph.emit('warn', err);
                            }
                        } else if (/(?:^| )serviceworker(?:$| )/i.test(rel)) {
                            // https://w3c.github.io/ServiceWorker/#link-type-serviceworker
                            addOutgoingRelation(new AssetGraph.HtmlServiceWorkerRegistration({
                                from: this,
                                to: {
                                    url: node.getAttribute('href')
                                },
                                node: node,
                                scope: node.getAttribute('scope')
                            }));
                        } else if (/(?:^| )author(?:$| )/i.test(rel)) {
                            var assetConfig = {
                                url: node.getAttribute('href')
                            };
                            if (node.hasAttribute('type')) {
                                assetConfig.contentType = node.getAttribute('type');
                            }
                            addOutgoingRelation(new AssetGraph.HtmlAuthorLink({
                                from: this,
                                to: assetConfig,
                                node: node
                            }));
                        } else if (/(?:^| )search(?:$| )/i.test(rel)) {
                            var assetConfig = {
                                url: node.getAttribute('href')
                            };
                            if (node.hasAttribute('type')) {
                                assetConfig.contentType = node.getAttribute('type');
                            }
                            addOutgoingRelation(new AssetGraph.HtmlSearchLink({
                                from: this,
                                to: assetConfig,
                                node: node
                            }));
                        } else if (/(?:^| )dns-prefetch(?:$| )/i.test(rel)) {
                            addOutgoingRelation(new AssetGraph.HtmlDnsPrefetchLink({
                                from: this,
                                to: {
                                    url: node.getAttribute('href')
                                },
                                node: node
                            }));
                        } else if (/(?:^| )preconnect(?:$| )/i.test(rel)) {
                            addOutgoingRelation(new AssetGraph.HtmlPreconnectLink({
                                from: this,
                                to: {
                                    url: node.getAttribute('href')
                                },
                                node: node
                            }));
                        } else if (/(?:^| )prerender(?:$| )/i.test(rel)) {
                            addOutgoingRelation(new AssetGraph.HtmlPrerenderLink({
                                from: this,
                                to: {
                                    url: node.getAttribute('href')
                                },
                                node: node
                            }));
                        } else if (/(?:^| )prefetch(?:$| )/i.test(rel)) {
                            var assetConfig = {
                                url: node.getAttribute('href')
                            };

                            var relationConfig = {
                                from: this,
                                to: assetConfig,
                                node: node
                            };

                            if (node.getAttribute('as')) {
                                relationConfig.as = node.getAttribute('as');
                            }

                            addOutgoingRelation(new AssetGraph.HtmlPrefetchLink(relationConfig));
                        } else if (/(?:^| )preload(?:$| )/i.test(rel)) {
                            var assetConfig = {
                                url: node.getAttribute('href')
                            };

                            if (node.hasAttribute('type')) {
                                assetConfig.contentType = node.getAttribute('type');
                            }

                            var relationConfig = {
                                from: this,
                                to: assetConfig,
                                node: node
                            };

                            if (node.getAttribute('as')) {
                                relationConfig.as = node.getAttribute('as');
                            }

                            addOutgoingRelation(new AssetGraph.HtmlPreloadLink(relationConfig));
                        } else if (/(?:^| )fluid-icon(?:$| )/i.test(rel)) {
                            var assetConfig = {
                                url: node.getAttribute('href')
                            };
                            if (node.hasAttribute('type')) {
                                assetConfig.contentType = node.getAttribute('type');
                            }
                            addOutgoingRelation(new AssetGraph.HtmlFluidIconLink({
                                from: this,
                                to: assetConfig,
                                node: node
                            }));
                        } else if (/(?:^| )logo(?:$| )/i.test(rel)) {
                            var assetConfig = {
                                url: node.getAttribute('href')
                            };
                            if (node.hasAttribute('type')) {
                                assetConfig.contentType = node.getAttribute('type');
                            }
                            addOutgoingRelation(new AssetGraph.HtmlLogo({
                                from: this,
                                to: assetConfig,
                                node: node
                            }));
                        } else if (/import/i.test(rel)) {
                            // HtmlImport specification: http://w3c.github.io/webcomponents/spec/imports/
                            addOutgoingRelation(new AssetGraph.HtmlImport({
                                from: this,
                                to: {
                                    url: node.getAttribute('href'),
                                    type: 'Html',
                                    // Web Compoonents are explicitly not to be treated as HTML fragments
                                    // Override automated isFragment resolving here
                                    isFragment: false
                                },
                                node: node
                            }));
                        }
                    }
                } else if (nodeName === 'meta') {
                    if (/^refresh$/i.test(node.getAttribute('http-equiv'))) {
                        var content = node.getAttribute('content'),
                            matchContent = content && content.match(/^\d+;\s*url\s*=\s*(.*?)\s*$/);
                        if (matchContent) {
                            addOutgoingRelation(new AssetGraph.HtmlMetaRefresh({
                                from: this,
                                to: {
                                    url: matchContent[1]
                                },
                                node: node
                            }));
                        }
                    } else if (/^og:(?:url|image|audio|video)(?:(?:$|:)(?:url|secure_url|$))/.test(node.getAttribute('property')) && node.hasAttribute('content')) {
                        addOutgoingRelation(new AssetGraph.HtmlOpenGraph({
                            from: this,
                            to: {
                                url: node.getAttribute('content')
                            },
                            node: node,
                            ogProperty: node.getAttribute('property')
                        }));
                    } else if (node.getAttribute('name') === 'msapplication-config' && node.hasAttribute('content')) {
                        addOutgoingRelation(new AssetGraph.HtmlMsApplicationConfig({
                            from: this,
                            to: {
                                type: 'MsApplicationConfig',
                                url: node.getAttribute('content')
                            },
                            node: node
                        }));
                    } else if (node.getAttribute('name') === 'msapplication-TileImage' && node.hasAttribute('content')) {
                        addOutgoingRelation(new AssetGraph.HtmlMsApplicationTileImageMeta({
                            from: this,
                            to: {
                                url: node.getAttribute('content')
                            },
                            node: node
                        }));
                    } else {
                        var httpEquivAttributeValue = node.getAttribute('http-equiv');
                        if (/^Content-Security-Policy(?:-Report-Only)?$/i.test(httpEquivAttributeValue)) {
                            var contentAttributeValue = node.getAttribute('content');
                            if (typeof contentAttributeValue === 'string') {
                                addOutgoingRelation(new AssetGraph.HtmlContentSecurityPolicy({
                                    from: this,
                                    isExternalizable: false,
                                    to: new AssetGraph.ContentSecurityPolicy({
                                        text: contentAttributeValue
                                    }),
                                    node: node
                                }));
                            }
                        }
                    }
                } else if (nodeName === 'img') {
                    var srcAttributeValue = node.getAttribute('src'),
                        srcSetAttributeValue = node.getAttribute('srcset');
                    if (srcAttributeValue) {
                        addOutgoingRelation(new AssetGraph.HtmlImage({
                            from: this,
                            to: {
                                url: srcAttributeValue
                            },
                            node: node
                        }));
                    }
                    if (srcSetAttributeValue) {
                        addOutgoingRelation(new AssetGraph.HtmlImageSrcSet({
                            from: this,
                            to: new (require('./SrcSet'))({
                                text: srcSetAttributeValue
                            }),
                            node: node
                        }));
                    }
                } else if (nodeName === 'a' && node.hasAttribute('href')) {
                    addOutgoingRelation(new AssetGraph.HtmlAnchor({
                        from: this,
                        to: {
                            url: node.getAttribute('href')
                        },
                        node: node
                    }));
                } else if (nodeName === 'iframe') {
                    if (node.hasAttribute('src')) {
                        addOutgoingRelation(new AssetGraph.HtmlIFrame({
                            from: this,
                            to: {
                                url: node.getAttribute('src')
                            },
                            node: node
                        }));
                    }
                    if (node.hasAttribute('srcdoc')) {
                        addOutgoingRelation(new AssetGraph.HtmlIFrameSrcDoc({
                            from: this,
                            to: new Html({
                                text: node.getAttribute('srcdoc')
                            }),
                            node: node
                        }));
                    }
                } else if (nodeName === 'frame' && node.hasAttribute('src')) {
                    addOutgoingRelation(new AssetGraph.HtmlFrame({
                        from: this,
                        to: {
                            url: node.getAttribute('src')
                        },
                        node: node
                    }));
                } else if (nodeName === 'esi:include' && node.hasAttribute('src')) {
                    addOutgoingRelation(new AssetGraph.HtmlEdgeSideInclude({
                        from: this,
                        to: {
                            url: node.getAttribute('src')
                        },
                        node: node
                    }));
                } else if (nodeName === 'video') {
                    if (node.hasAttribute('src')) {
                        addOutgoingRelation(new AssetGraph[nodeName === 'video' ? 'HtmlVideo' : 'HtmlAudio']({
                            from: this,
                            to: {
                                url: node.getAttribute('src')
                            },
                            node: node
                        }));
                    }
                    if (node.hasAttribute('poster')) {
                        addOutgoingRelation(new AssetGraph.HtmlVideoPoster({
                            from: this,
                            to: {
                                url: node.getAttribute('poster')
                            },
                            node: node
                        }));
                    }
                } else if (nodeName === 'audio' && node.hasAttribute('src')) {
                    addOutgoingRelation(new AssetGraph.HtmlAudio({
                        from: this,
                        to: {
                            url: node.getAttribute('src')
                        },
                        node: node
                    }));
                } else if (/^(?:source|track)$/i.test(nodeName) && node.parentNode && /^(?:video|audio)$/i.test(node.parentNode.nodeName) && node.hasAttribute('src')) {
                    addOutgoingRelation(new AssetGraph[node.parentNode.nodeName.toLowerCase() === 'video' ? 'HtmlVideo' : 'HtmlAudio']({
                        from: this,
                        to: {
                            url: node.getAttribute('src')
                        },
                        node: node
                    }));
                } else if (nodeName === 'source' && node.parentNode && node.parentNode.nodeName.toLowerCase() === 'picture') {
                    var srcAttributeValue = node.getAttribute('src'),
                        srcSetAttributeValue = node.getAttribute('srcset');
                    if (srcAttributeValue) {
                        addOutgoingRelation(new AssetGraph.HtmlPictureSource({
                            from: this,
                            to: {
                                url: srcAttributeValue
                            },
                            node: node
                        }));
                    }
                    if (srcSetAttributeValue) {
                        addOutgoingRelation(new AssetGraph.HtmlPictureSourceSrcSet({
                            from: this,
                            to: new (require('./SrcSet'))({
                                text: srcSetAttributeValue
                            }),
                            node: node
                        }));
                    }
                } else if (nodeName === 'object' && node.hasAttribute('data')) {
                    addOutgoingRelation(new AssetGraph.HtmlObject({
                        from: this,
                        to: {
                            url: node.getAttribute('data')
                        },
                        node: node,
                        attributeName: 'data'
                    }));
                } else if (nodeName === 'param' && /^(?:src|movie)$/i.test(node.getAttribute('name')) && node.parentNode && node.parentNode.nodeName.toLowerCase() === 'object' && node.hasAttribute('value')) {
                    addOutgoingRelation(new AssetGraph.HtmlObject({
                        from: this,
                        to: {
                            url: node.getAttribute('value')
                        },
                        node: node,
                        attributeName: 'value'
                    }));
                } else if (nodeName === 'applet') {
                    ['archive', 'codebase'].forEach(function (attributeName) {
                        // Note: Only supports one url in the archive attribute. The Html 4.01 spec says it can be a comma-separated list.
                        if (node.hasAttribute(attributeName)) {
                            addOutgoingRelation(new AssetGraph.HtmlApplet({
                                from: this,
                                to: {
                                    url: node.getAttribute(attributeName)
                                },
                                node: node,
                                attributeName: attributeName
                            }));
                        }
                    }, this);
                } else if (nodeName === 'embed' && node.hasAttribute('src')) {
                    addOutgoingRelation(new AssetGraph.HtmlEmbed({
                        from: this,
                        to: {
                            url: node.getAttribute('src')
                        },
                        node: node
                    }));
                } else if (nodeName === 'svg') {
                    addOutgoingRelation(new AssetGraph.HtmlSvgIsland({
                        from: this,
                        to: new AssetGraph.Svg({
                            isExternalizable: false,
                            text: node.outerHTML
                        }),
                        node: node
                    }));
                }
                if (node.hasAttribute('style')) {
                    addOutgoingRelation(new AssetGraph.HtmlStyleAttribute({
                        from: this,
                        to: new (require('./Css'))({
                            isExternalizable: false,
                            text: 'bogusselector {' + node.getAttribute('style') + '}'
                        }),
                        node: node
                    }));
                }
                // Handle Knockout.js attributes (data-bind, params)
                ['data-bind', 'params'].forEach(function (attributeName) {
                    if (node.hasAttribute(attributeName)) {
                        var AttributeRelation;
                        if (attributeName === 'data-bind') {
                            AttributeRelation = AssetGraph.HtmlDataBindAttribute;
                        } else if (attributeName === 'params') {
                            AttributeRelation = AssetGraph.HtmlParamsAttribute;
                        } else {
                            return;
                        }
                        // See if the attribute value can be parsed as a Knockout.js data-bind:
                        var javaScriptObjectLiteral = '({' + node.getAttribute(attributeName).replace(/^\s*\{(.*)\}\s*$/, '$1') + '});',
                            parseTree = null; // Must be set to something falsy each time we make it here
                        try {
                            parseTree = esprima.parse(javaScriptObjectLiteral);
                        } catch (e) {}

                        if (parseTree) {
                            addOutgoingRelation(new AttributeRelation({
                                from: this,
                                to: new JavaScript({
                                    isExternalizable: false,
                                    serializationOptions: {
                                        semicolons: true,
                                        side_effects: false,
                                        newline: '',
                                        indent_level: 0
                                    },
                                    parseTree: parseTree,
                                    text: javaScriptObjectLiteral
                                }),
                                node: node
                            }));
                        }
                    }
                }, this);
            } else if (node.nodeType === node.COMMENT_NODE) {
                // <!--[if !IE]> --> ... <!-- <![endif]-->
                // <!--[if IE gte 8]><!--> ... <!--<![endif]--> (evaluated by certain IE versions and all non-IE browsers)
                var matchNonInternetExplorerConditionalComment = node.nodeValue.match(/^\[if\s*([^\]]*)\]>\s*(?:<!)?$/);
                if (matchNonInternetExplorerConditionalComment) {
                    currentConditionalComments.push(node);
                } else if (/^\s*<!\[endif\]\s*$/.test(node.nodeValue)) {
                    if (currentConditionalComments.length > 0) {
                        currentConditionalComments.pop();
                    } else {
                        var warning = new errors.SyntaxError({message: 'Html: Conditional comment end marker seen without a start marker: ' + node.nodeValue, asset: this});
                        if (this.assetGraph) {
                            this.assetGraph.emit('warn', warning);
                        } else {
                            console.warn(this.toString() + ': ' + warning.message);
                        }
                    }
                } else {
                    // <!--[if ...]> .... <![endif]-->
                    var matchConditionalComment = node.nodeValue.match(/^\[if\s*([^\]]*)\]\>([\s\S]*)<!\[endif\]$/);
                    if (matchConditionalComment) {
                        addOutgoingRelation(new AssetGraph.HtmlConditionalComment({
                            from: this,
                            to: new Html({
                                sourceUrl: this.sourceUrl || this.url,
                                text: '<!--ASSETGRAPH DOCUMENT START MARKER-->' + matchConditionalComment[2] + '<!--ASSETGRAPH DOCUMENT END MARKER-->'
                            }),
                            node: node,
                            condition: matchConditionalComment[1]
                        }));
                    } else {
                        var matchKnockoutContainerless = node.nodeValue.match(/^\s*ko\s+([\s\S]+)$/);
                        if (matchKnockoutContainerless) {
                            addOutgoingRelation(new AssetGraph.HtmlKnockoutContainerless({
                                from: this,
                                to: new (require('./JavaScript'))({
                                    isExternalizable: false,
                                    serializationOptions: {
                                        semicolons: true,
                                        side_effects: false,
                                        newline: '',
                                        indent_level: 0
                                    },
                                    text: '({' + matchKnockoutContainerless[1] + '});'
                                }),
                                node: node
                            }));
                        } else {
                            var matchEsi = node.nodeValue.match(/^esi([\s\S]*)$/);
                            if (matchEsi) {
                                addOutgoingRelation(new AssetGraph.HtmlEdgeSideIncludeSafeComment({
                                    from: this,
                                    to: new Html({
                                        text: '<!--ASSETGRAPH DOCUMENT START MARKER-->' + matchEsi[1] + '<!--ASSETGRAPH DOCUMENT END MARKER-->'
                                    }),
                                    node: node
                                }));
                            }
                        }
                    }
                }
            }

            if (traverse && node.childNodes) {
                for (var i = node.childNodes.length - 1 ; i >= 0 ; i -= 1) {
                    queue.unshift(node.childNodes[i]);
                }
            }
        }
        if (currentConditionalComments.length > 0) {
            var warning = new errors.SyntaxError({message: 'Html: No end marker found for conditional comment(s):\n' + _.map(currentConditionalComments, 'nodeValue').join('\n  '), asset: this});
            if (this.assetGraph) {
                this.assetGraph.emit('warn', warning);
            } else {
                console.warn(this.toString() + ': ' + warning.message);
            }
        }
        return outgoingRelations;
    },

    allowsPerCsp: function (directive, urlOrToken, protectedResourceUrl) {
        var csps = [];
        this.outgoingRelations.forEach(function (outgoingRelation) {
            if (outgoingRelation.type === 'HtmlContentSecurityPolicy' && outgoingRelation.to && outgoingRelation.to.type === 'ContentSecurityPolicy') {
                csps.push(outgoingRelation.to);
            }
        });
        return csps.every(function (csp) {
            return csp.allows(directive, urlOrToken, protectedResourceUrl);
        }, this);
    },

    minify: function () {
        this.isPretty = false;
        this.isMinified = true;
        // html-minifier doesn't (yet) have to ability to selectively process comments, so
        // we trim whitespace from Knockout and Htmlizer containerless bindings in a separate pass:
        (function traverse(node, isWithinSensitiveTag, canRemoveLeadingWhiteSpace, canRemoveTrailingWhiteSpace) {
            var isInWhiteSpaceInsensitiveContext = isWhiteSpaceInsensitiveByTagName[node.nodeName.toLowerCase()] || false;
            isWithinSensitiveTag = isWithinSensitiveTag || isSensitiveByTagName[node.nodeName.toLowerCase()] || false;
            for (var i = 0 ; i < node.childNodes.length ; i += 1) {
                var childNode = node.childNodes[i];
                if (childNode.nodeType === childNode.ELEMENT_NODE) {
                    canRemoveLeadingWhiteSpace = traverse(childNode,
                                                          isWithinSensitiveTag,
                                                          canRemoveLeadingWhiteSpace,
                                                          childNode.nextSibling ? childNode.nextSibling.nodeType === childNode.TEXT_NODE && /^[ \t\n\r]/.test(childNode.nextSibling.nodeValue) : canRemoveTrailingWhiteSpace
                                                          );
                } else if (childNode.nodeType === childNode.COMMENT_NODE) {
                    if (/^\s*\/?(?:ko|hz)(?:\s|$)/.test(childNode.nodeValue)) {
                        // Knockout.js or Htmlizer containerless binding start or end marker. Remove superfluous whitespace:
                        childNode.nodeValue = childNode.nodeValue.replace(/^\s+|\s+$/g, '');
                    } else if (!/^ASSETGRAPH DOCUMENT (?:START|END) MARKER$|^#|^\[if|^<!\[endif\]|^esi/.test(childNode.nodeValue)) {
                        // Non-SSI, non-conditional comment
                        node.removeChild(childNode);
                        i -= 1;
                    } else {
                        // Preserve whitespace after comment nodes that are preserved:
                        canRemoveLeadingWhiteSpace = false;
                    }
                } else if (childNode.nodeType === childNode.TEXT_NODE) {
                    var childNodeValue = childNode.nodeValue;
                    if (childNode.previousSibling && childNode.previousSibling.nodeType === childNode.TEXT_NODE) {
                        // Collapse with neighbouring text node:
                        childNodeValue = childNode.previousSibling.nodeValue + childNodeValue;
                        node.removeChild(childNode.previousSibling);
                        i -= 1;
                    }
                    if (!isWithinSensitiveTag) {
                        if (canRemoveLeadingWhiteSpace) {
                            childNodeValue = childNodeValue.replace(/^[ \n\r\t]+/, '');
                        }
                        if (canRemoveTrailingWhiteSpace && (!childNode.nextSibling || (childNode.nextSibling.nodeType === childNode.ELEMENT_NODE && isWhiteSpaceInsensitiveByTagName[childNode.nextSibling.nodeName.toLowerCase()]))) {
                            childNodeValue = childNodeValue.replace(/[ \n\r\t]+$/, '');
                        }
                        childNodeValue = childNodeValue.replace(/[ \n\r\t]{2,}/g, ' ');
                    }
                    if (childNodeValue) {
                        canRemoveLeadingWhiteSpace = /[ \n\r\t]$/.test(childNodeValue);
                        childNode.nodeValue = childNodeValue;
                    } else {
                        node.removeChild(childNode);
                        i -= 1;
                    }
                }
            }
            if (node.childNodes.length === 0 && !isInWhiteSpaceInsensitiveContext) {
                // Whitespace after an empty tag in non-block level context should be preserved
                return false;
            } else {
                return canRemoveLeadingWhiteSpace || isInWhiteSpaceInsensitiveContext;
            }
        }(this.parseTree, false, true, true));

        this.markDirty();
        return this;
    },

    prettyPrint: function () {
        this.isPretty = true;
        this.isMinified = false;
        this.markDirty();
        return this;
    }
});

module.exports = Html;
