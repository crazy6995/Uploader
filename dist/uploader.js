/*!
 * Uploader - Uploader library implements html5 file upload and provides multiple simultaneous, stable, fault tolerant and resumable uploads
 * @version v0.0.1
 * @author dolymood <dolymood@gmail.com>
 * @link https://github.com/simple-uploader/Uploader
 * @license MIT
 */
!function(e){if("object"==typeof exports)module.exports=e();else if("function"==typeof define&&define.amd)define(e);else{var f;"undefined"!=typeof window?f=window:"undefined"!=typeof global?f=global:"undefined"!=typeof self&&(f=self),f.Uploader=e()}}(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(_dereq_,module,exports){
var utils = _dereq_('./utils')

function Chunk (uploader, file, offset) {
	this.uploader = uploader
	this.file = file
	this.bytes = null
	this.offset = offset
	this.tested = false
	this.retries = 0
	this.pendingRetry = false
	this.preprocessState = 0
	this.readState = 0
	this.loaded = 0
	this.total = 0
	this.chunkSize = this.uploader.opts.chunkSize
	this.startByte = this.offset * this.chunkSize
	this.endByte = this.computeEndByte()
	this.xhr = null
}

var STATUS = Chunk.STATUS = {
	PENDING: 'pending',
	UPLOADING: 'uploading',
	READING: 'reading',
	SUCCESS: 'success',
	ERROR: 'error',
	COMPLETE: 'complete',
	PROGRESS: 'progress',
	RETRY: 'retry'
}

utils.extend(Chunk.prototype, {

	_event: function (evt, args) {
		args = utils.toArray(arguments)
		args.unshift(this)
		this.file._chunkEvent.apply(this.file, args)
	},

	computeEndByte: function () {
		var endByte = Math.min(this.file.size, (this.offset + 1) * this.chunkSize)
		if (this.file.size - endByte < this.chunkSize && !this.uploader.opts.forceChunkSize) {
			// The last chunk will be bigger than the chunk size,
			// but less than 2 * this.chunkSize
			endByte = this.file.size
		}
		return endByte
	},

	getParams: function () {
		return {
			chunkNumber: this.offset + 1,
			chunkSize: this.uploader.opts.chunkSize,
			currentChunkSize: this.endByte - this.startByte,
			totalSize: this.file.size,
			identifier: this.file.uniqueIdentifier,
			filename: this.file.name,
			relativePath: this.file.relativePath,
			totalChunks: this.file.chunks.length
		}
	},

	getTarget: function (target, params) {
		if (target.indexOf('?') < 0) {
			target += '?'
		} else {
			target += '&'
		}
		return target + params.join('&')
	},

	test: function () {
		this.xhr = new XMLHttpRequest()
		this.xhr.addEventListener('load', testHandler, false)
		this.xhr.addEventListener('error', testHandler, false)
		var testMethod = utils.evalOpts(this.uploader.opts.testMethod, this.file, this)
		var data = this.prepareXhrRequest(testMethod, true)
		this.xhr.send(data)

		var $ = this
		function testHandler (event) {
			var status = $.status(true)
			if (status === STATUS.ERROR) {
				$._event(status, $.message())
				$.uploader.uploadNextChunk()
			} else if (status === STATUS.SUCCESS) {
				$.tested = true
				$._event(status, $.message())
				$.uploader.uploadNextChunk()
			} else if (!$.file.paused) {
				// Error might be caused by file pause method
				// Chunks does not exist on the server side
				$.tested = true
				$.send()
			}
		}
	},

	preprocessFinished: function () {
		// Compute the endByte after the preprocess function to allow an
		// implementer of preprocess to set the fileObj size
		this.endByte = this.computeEndByte()
		this.preprocessState = 2
		this.send()
	},

	readFinished: function (bytes) {
		this.readState = 2
		this.bytes = bytes
		this.send()
	},

	send: function () {
		var preprocess = this.uploader.opts.preprocess
		var read = this.uploader.opts.readFileFn
		if (utils.isFunction(preprocess)) {
			switch (this.preprocessState) {
				case 0:
					this.preprocessState = 1
					preprocess(this)
					return
				case 1:
					return
			}
		}
		switch (this.readState) {
			case 0:
				this.readState = 1
				read(this.file, this.file.fileType, this.startByte, this.endByte, this)
				return
			case 1:
				return
		}
		if (this.uploader.opts.testChunks && !this.tested) {
			this.test()
			return
		}

		this.loaded = 0
		this.total = 0
		this.pendingRetry = false

		// Set up request and listen for event
		this.xhr = new XMLHttpRequest()
		this.xhr.upload.addEventListener('progress', progressHandler, false)
		this.xhr.addEventListener('load', doneHandler, false)
		this.xhr.addEventListener('error', doneHandler, false)

		var uploadMethod = utils.evalOpts(this.uploader.opts.uploadMethod, this.file, this)
		var data = this.prepareXhrRequest(uploadMethod, false, this.uploader.opts.method, this.bytes)
		this.xhr.send(data)

		var $ = this
		function progressHandler (event) {
			if (event.lengthComputable) {
				$.loaded = event.loaded
				$.total = event.total
			}
			$._event(STATUS.PROGRESS, event)
		}

		function doneHandler (event) {
			var status = $.status()
			if (status === STATUS.SUCCESS || status === STATUS.ERROR) {
				delete this.data
				$._event(status, $.message())
				$.uploader.uploadNextChunk()
			} else {
				$._event(STATUS.RETRY, $.message())
				$.pendingRetry = true
				$.abort()
				$.retries++
				var retryInterval = $.uploader.opts.chunkRetryInterval
				if (retryInterval !== null) {
					setTimeout(function () {
						$.send()
					}, retryInterval)
				} else {
					$.send()
				}
			}
		}
	},

	abort: function () {
		var xhr = this.xhr
		this.xhr = null
		if (xhr) {
			xhr.abort()
		}
	},

	status: function (isTest) {
		if (this.readState === 1) {
			return STATUS.READING
		} else if (this.pendingRetry || this.preprocessState === 1) {
			// if pending retry then that's effectively the same as actively uploading,
			// there might just be a slight delay before the retry starts
			return STATUS.UPLOADING
		} else if (!this.xhr) {
			return STATUS.PENDING
		} else if (this.xhr.readyState < 4) {
			// Status is really 'OPENED', 'HEADERS_RECEIVED'
			// or 'LOADING' - meaning that stuff is happening
			return STATUS.UPLOADING
		} else {
			if (this.uploader.opts.successStatuses.indexOf(this.xhr.status) > -1) {
				// HTTP 200, perfect
				// HTTP 202 Accepted - The request has been accepted for processing, but the processing has not been completed.
				return STATUS.SUCCESS
			} else if (this.uploader.opts.permanentErrors.indexOf(this.xhr.status) > -1 ||
					!isTest && this.retries >= this.uploader.opts.maxChunkRetries) {
				// HTTP 415/500/501, permanent error
				return STATUS.ERROR
			} else {
				// this should never happen, but we'll reset and queue a retry
				// a likely case for this would be 503 service unavailable
				this.abort()
				return STATUS.PENDING
			}
		}
	},

	message: function () {
		return this.xhr ? this.xhr.responseText : ''
	},

	progress: function () {
		if (this.pendingRetry) {
			return 0
		}
		var s = this.status()
		if (s === STATUS.SUCCESS || s === STATUS.ERROR) {
			return 1
		} else if (s === STATUS.PENDING) {
			return 0
		} else {
			return this.total > 0 ? this.loaded / this.total : 0
		}
	},

	sizeUploaded: function () {
		var size = this.endByte - this.startByte
		// can't return only chunk.loaded value, because it is bigger than chunk size
		if (this.status() !== STATUS.SUCCESS) {
			size = this.progress() * size
		}
		return size
	},

	prepareXhrRequest: function (method, isTest, paramsMethod, blob) {
		// Add data from the query options
		var query = utils.evalOpts(this.uploader.opts.query, this.file, this, isTest)
		query = utils.extend(this.getParams(), query)

		var target = utils.evalOpts(this.uploader.opts.target, this.file, this, isTest)
		var data = null
		if (method === 'GET' || paramsMethod === 'octet') {
			// Add data from the query options
			var params = []
			utils.each(query, function (v, k) {
				params.push([encodeURIComponent(k), encodeURIComponent(v)].join('='))
			})
			target = this.getTarget(target, params)
			data = blob || null
		} else {
			// Add data from the query options
			data = new FormData()
			utils.each(query, function (v, k) {
				data.append(k, v)
			})
			data.append(this.uploader.opts.fileParameterName, blob, this.file.name)
		}

		this.xhr.open(method, target, true)
		this.xhr.withCredentials = this.uploader.opts.withCredentials

		// Add data from header options
		utils.each(utils.evalOpts(this.uploader.opts.headers, this.file, this, isTest), function (v, k) {
			this.xhr.setRequestHeader(k, v)
		}, this)

		return data
	}

})

module.exports = Chunk

},{"./utils":5}],2:[function(_dereq_,module,exports){
var each = _dereq_('./utils').each

var event = {

	_eventData: null,

	on: function (name, func) {
		if (!this._eventData) this._eventData = {}
		if (!this._eventData[name]) this._eventData[name] = []
		var listened = false
		each(this._eventData[name], function (fuc) {
			if (fuc === func) {
				listened = true
				return false
			}
		})
		if (!listened) {
			this._eventData[name].push(func)
		}
	},

	off: function (name, func) {
		if (!this._eventData) this._eventData = {}
		if (!this._eventData[name] || !this._eventData[name].length) return
		if (func) {
			each(this._eventData[name], function (fuc, i) {
				if (fuc === func) {
					this._eventData[name].splice(i, 1)
					return false
				}
			}, this)
		} else {
			this._eventData[name] = []
		}
	},

	trigger: function (name) {
		if (!this._eventData) this._eventData = {}
		if (!this._eventData[name]) return true
		var args = this._eventData[name].slice.call(arguments, 1)
		var preventDefault = false
		each(this._eventData[name], function (fuc) {
			preventDefault = fuc.apply(this, args) === false || preventDefault
		}, this)
		return !preventDefault
	}
}

module.exports = event

},{"./utils":5}],3:[function(_dereq_,module,exports){
var utils = _dereq_('./utils')
var event = _dereq_('./event')
var File = _dereq_('./file')
var Chunk = _dereq_('./chunk')

var version = '0.0.1'

// ie10+
var ie10plus = window.navigator.msPointerEnabled
var support = (function () {
	var sliceName = 'slice'
	var _support = utils.isDefined(window.File) && utils.isDefined(window.Blob) &&
								utils.isDefined(window.FileList)
	var bproto = null
	if (_support) {
		bproto = window.Blob.prototype
		utils.each(['slice', 'webkitSlice', 'mozSlice'], function (n) {
			if (bproto[n]) {
				sliceName = n
				return false
			}
		})
		_support = !!bproto[sliceName]
	}
	if (_support) Uploader.sliceName = sliceName
	bproto = null
	return _support
})()

var supportDirectory = (function () {
	var input = window.document.createElement('input')
	input.type = 'file'
	var sd = 'webkitdirectory' in input || 'directory' in input
	input = null
	return sd
})()

function Uploader (opts) {
	this.support = support
	if (!this.support) {
		return
	}
	this.supportDirectory = supportDirectory
	this.filePaths = {}
	this.opts = utils.extend({}, Uploader.defaults, opts || {})

	File.call(this, this)
}

/**
 * Default read function using the webAPI
 *
 * @function webAPIFileRead(fileObj, fileType, startByte, endByte, chunk)
 *
 */
var webAPIFileRead = function (fileObj, fileType, startByte, endByte, chunk) {
	var function_name = 'slice'

	if (fileObj.file.slice) {
		function_name = 'slice'
	} else if (fileObj.file.mozSlice) {
		function_name = 'mozSlice'
	} else if (fileObj.file.webkitSlice) {
		function_name = 'webkitSlice'
	}
	chunk.readFinished(fileObj.file[function_name](startByte, endByte, fileType))
}

Uploader.version = version

Uploader.defaults = {
	chunkSize: 1024 * 1024,
	forceChunkSize: false,
	simultaneousUploads: 3,
	singleFile: false,
	fileParameterName: 'file',
	progressCallbacksInterval: 500,
	speedSmoothingFactor: 0.1,
	query: {},
	headers: {},
	withCredentials: false,
	preprocess: null,
	method: 'multipart',
	testMethod: 'GET',
	uploadMethod: 'POST',
	prioritizeFirstAndLastChunk: false,
	allowDuplicateUploads: false,
	target: '/',
	testChunks: true,
	generateUniqueIdentifier: null,
	maxChunkRetries: 0,
	chunkRetryInterval: null,
	permanentErrors: [404, 415, 500, 501],
	successStatuses: [200, 201, 202],
	onDropStopPropagation: false,
	initFileFn: null,
	readFileFn: webAPIFileRead
}

Uploader.utils = utils
Uploader.event = event
Uploader.File = File
Uploader.Chunk = Chunk

// inherit file
Uploader.prototype = utils.extend({}, File.prototype)
// inherit event
utils.extend(Uploader.prototype, event)
utils.extend(Uploader.prototype, {

	constructor: Uploader,

	_trigger: function (name) {
		var args = utils.toArray(arguments)
		var preventDefault = !this.trigger.apply(this, arguments)
		if (name !== 'catchAll') {
			args.unshift('catchAll')
			preventDefault = !this.trigger.apply(this, args) || preventDefault
		}
		return !preventDefault
	},

	_triggerAsync: function () {
		var args = arguments
		utils.nextTick(function () {
			this._trigger.apply(this, args)
		}, this)
	},

	onDrop: function (evt) {
		if (this.opts.onDropStopPropagation) {
			evt.stopPropagation()
		}
		evt.preventDefault()
		var dataTransfer = evt.dataTransfer
		if (dataTransfer.items && dataTransfer.items[0] &&
			dataTransfer.items[0].webkitGetAsEntry) {
			this.webkitReadDataTransfer(evt)
		} else {
			this.addFiles(dataTransfer.files, evt)
		}
	},

	webkitReadDataTransfer: function (evt) {
		var self = this
		var queue = evt.dataTransfer.items.length
		var files = []
		utils.each(evt.dataTransfer.items, function (item) {
			var entry = item.webkitGetAsEntry()
			if (!entry) {
				decrement()
				return
			}
			if (entry.isFile) {
				// due to a bug in Chrome's File System API impl - #149735
				fileReadSuccess(item.getAsFile(), entry.fullPath)
			} else {
				readDirectory(entry.createReader())
			}
		})
		function readDirectory (reader) {
			reader.readEntries(function (entries) {
				if (entries.length) {
					queue += entries.length
					utils.each(entries, function (entry) {
						if (entry.isFile) {
							var fullPath = entry.fullPath
							entry.file(function (file) {
								fileReadSuccess(file, fullPath)
							}, readError)
						} else if (entry.isDirectory) {
							readDirectory(entry.createReader())
						}
					})
					readDirectory(reader)
				} else {
					decrement()
				}
			}, readError)
		}
		function fileReadSuccess (file, fullPath) {
			// relative path should not start with "/"
			file.relativePath = fullPath.substring(1)
			files.push(file)
			decrement()
		}
		function readError (fileError) {
			throw fileError
		}
		function decrement () {
			if (--queue === 0) {
				self.addFiles(files, evt)
			}
		}
	},

	addFiles: function (files, evt) {
		var _files = []
		var oldFileListLen = this.fileList.length
		utils.each(files, function (file) {
			// Uploading empty file IE10/IE11 hangs indefinitely
			// Directories have size `0` and name `.`
			// Ignore already added files if opts.allowDuplicateUploads is set to false
			if ((!ie10plus || ie10plus && file.size > 0) && !(file.size % 4096 === 0 && (file.name === '.' || file.fileName === '.'))) {
				var uniqueIdentifier = this.generateUniqueIdentifier(file)
				if (this.opts.allowDuplicateUploads || !this.getFromUniqueIdentifier(uniqueIdentifier)) {
					var _file = new File(this, file, this)
					_file.uniqueIdentifier = uniqueIdentifier
					if (this._trigger('fileAdded', _file, evt)) {
						_files.push(_file)
					}
				}
			}
		}, this)
		// get new fileList
		var newFileList = this.fileList.slice(oldFileListLen)
		if (this._trigger('filesAdded', _files, newFileList, evt)) {
			utils.each(_files, function (file) {
				if (this.opts.singleFile && this.files.length > 0) {
					this.removeFile(this.files[0])
				}
				this.files.push(file)
			}, this)
			this._trigger('filesSubmitted', _files, newFileList, evt)
		}
	},

	addFile: function (file, evt) {
		this.addFiles([file], evt)
	},

	removeFile: function (file) {
		File.prototype.removeFile.call(this, file)
		this._trigger('fileRemoved', file)
	},

	generateUniqueIdentifier: function (file) {
		var custom = this.opts.generateUniqueIdentifier
		if (utils.isFunction(custom)) {
			return custom(file)
		}
		// Some confusion in different versions of Firefox
		var relativePath = file.relativePath || file.webkitRelativePath || file.fileName || file.name
		return file.size + '-' + relativePath.replace(/[^0-9a-zA-Z_-]/img, '')
	},

	getFromUniqueIdentifier: function (uniqueIdentifier) {
		var ret = false
		utils.each(this.files, function (file) {
			if (file.uniqueIdentifier === uniqueIdentifier) {
				ret = file
				return false
			}
		})
		return ret
	},

	uploadNextChunk: function (preventEvents) {
		var found = false
		var pendingStatus = Chunk.STATUS.PENDING
		if (this.opts.prioritizeFirstAndLastChunk) {
			utils.each(this.files, function (file) {
				if (!file.paused && file.chunks.length &&
					file.chunks[0].status() === pendingStatus) {
					file.chunks[0].send()
					found = true
					return false
				}
				if (!file.paused && file.chunks.length > 1 &&
					file.chunks[file.chunks.length - 1].status() === pendingStatus) {
					file.chunks[file.chunks.length - 1].send()
					found = true
					return false
				}
			})
			if (found) {
				return found
			}
		}

		// Now, simply look for the next, best thing to upload
		utils.each(this.files, function (file) {
			if (!file.paused) {
				utils.each(file.chunks, function (chunk) {
					if (chunk.status() === pendingStatus) {
						chunk.send()
						found = true
						return false
					}
				})
			}
			if (found) {
				return false
			}
		})
		if (found) {
			return true
		}

		// The are no more outstanding chunks to upload, check is everything is done
		var outstanding = false
		utils.each(this.files, function (file) {
			if (!file.isComplete()) {
				outstanding = true
				return false
			}
		})
		if (!outstanding && !preventEvents) {
			// All chunks have been uploaded, complete
			this._triggerAsync('complete')
		}
		return false
	},

	upload: function () {
		// Make sure we don't start too many uploads at once
		var ret = this._shouldUploadNext()
		if (ret === false) {
			return
		}
		this._trigger('uploadStart')
		var started = false
		for (var num = 1; num <= this.opts.simultaneousUploads - ret; num++) {
			started = this.uploadNextChunk(true) || started
		}
		if (!started) {
			this._triggerAsync('complete')
		}
	},

	/**
	 * should upload next chunk
	 * @function
	 * @returns {Boolean|Number}
	 */
	_shouldUploadNext: function () {
		var num = 0
		var should = true
		var simultaneousUploads = this.opts.simultaneousUploads
		var uploadingStatus = Chunk.STATUS.UPLOADING
		utils.each(this.files, function (file) {
			utils.each(file.chunks, function (chunk) {
				if (chunk.status() === uploadingStatus) {
					num++
					if (num >= simultaneousUploads) {
						should = false
						return false
					}
				}
			})
		})
		// if should is true then return uploading chunks's length
		return should && num
	},

	/**
	 * Assign a browse action to one or more DOM nodes.
	 * @function
	 * @param {Element|Array.<Element>} domNodes
	 * @param {boolean} isDirectory Pass in true to allow directories to
	 * @param {boolean} singleFile prevent multi file upload
	 * @param {Object} attributes set custom attributes:
	 *  http://www.w3.org/TR/html-markup/input.file.html#input.file-attributes
	 *  eg: accept: 'image/*'
	 * be selected (Chrome only).
	 */
	assignBrowse: function (domNodes, isDirectory, singleFile, attributes) {
		if (typeof domNodes.length === 'undefined') {
			domNodes = [domNodes]
		}

		utils.each(domNodes, function (domNode) {
			var input
			if (domNode.tagName === 'INPUT' && domNode.type === 'file') {
				input = domNode
			} else {
				input = document.createElement('input')
				input.setAttribute('type', 'file')
				// display:none - not working in opera 12
				utils.extend(input.style, {
					visibility: 'hidden',
					position: 'absolute',
					width: '1px',
					height: '1px'
				})
				// for opera 12 browser, input must be assigned to a document
				domNode.appendChild(input)
				// https://developer.mozilla.org/en/using_files_from_web_applications)
				// event listener is executed two times
				// first one - original mouse click event
				// second - input.click(), input is inside domNode
				domNode.addEventListener('click', function () {
					input.click()
				}, false)
			}
			if (!this.opts.singleFile && !singleFile) {
				input.setAttribute('multiple', 'multiple')
			}
			if (isDirectory) {
				input.setAttribute('webkitdirectory', 'webkitdirectory')
			}
			attributes && utils.each(attributes, function (value, key) {
				input.setAttribute(key, value)
			})
			// When new files are added, simply append them to the overall list
			var that = this
			input.addEventListener('change', function (e) {
				if (e.target.value) {
					that.addFiles(e.target.files, e)
					e.target.value = ''
				}
			}, false)
		}, this)
	},

	/**
	 * Assign one or more DOM nodes as a drop target.
	 * @function
	 * @param {Element|Array.<Element>} domNodes
	 */
	assignDrop: function (domNodes) {
		if (typeof domNodes.length === 'undefined') {
			domNodes = [domNodes]
		}
		this._onDrop = utils.bind(this.onDrop, this)
		utils.each(domNodes, function (domNode) {
			domNode.addEventListener('dragover', utils.preventEvent, false)
			domNode.addEventListener('dragenter', utils.preventEvent, false)
			domNode.addEventListener('drop', this._onDrop, false)
		}, this)
	},

	/**
	 * Un-assign drop event from DOM nodes
	 * @function
	 * @param domNodes
	 */
	unAssignDrop: function (domNodes) {
		if (typeof domNodes.length === 'undefined') {
			domNodes = [domNodes]
		}
		utils.each(domNodes, function (domNode) {
			domNode.removeEventListener('dragover', utils.preventEvent, false)
			domNode.removeEventListener('dragenter', utils.preventEvent, false)
			domNode.removeEventListener('drop', this._onDrop, false)
			this._onDrop = null
		}, this)
	}

})

module.exports = Uploader

},{"./chunk":1,"./event":2,"./file":4,"./utils":5}],4:[function(_dereq_,module,exports){
var utils = _dereq_('./utils')
var Chunk = _dereq_('./chunk')

function File (uploader, file, parent) {
	this.uploader = uploader
	this.isRoot = this.isFolder = uploader === this
	this.parent = parent || null
	this.files = []
	this.fileList = []
	this.chunks = []

	if (this.isRoot || !file) {
		this.file = null
	} else {
		if (utils.isString(file)) {
			// folder
			this.isFolder = true
			this.path = file
			if (this.parent.path) {
				file = file.substr(this.parent.path.length)
			}
			this.name = file.charAt(file.length - 1) === '/' ? file.substr(0, file.length - 1) : file
		} else {
			this.file = file
			this.fileType = this.file.type
			this.name = file.fileName || file.name
			this.size = file.size
			this.relativePath = file.relativePath || file.webkitRelativePath || this.name
			this._parseFile()
		}
	}

	this.started = false
	this.paused = false
	this.error = false
	this.averageSpeed = 0
	this.currentSpeed = 0
	this._lastProgressCallback = Date.now()
	this._prevUploadedSize = 0
	this._prevProgress = 0

	this.bootstrap()
}

utils.extend(File.prototype, {

	_parseFile: function () {
		var ppaths = parsePaths(this.relativePath)
		if (ppaths.length) {
			var filePaths = this.uploader.filePaths
			utils.each(ppaths, function (path, i) {
				var folderFile = filePaths[path]
				if (!folderFile) {
					folderFile = new File(this.uploader, path, this.parent)
					filePaths[path] = folderFile
					this._updateParentFileList(folderFile)
				}
				this.parent = folderFile
				if (!ppaths[i + 1]) {
					folderFile.files.push(this)
					folderFile.fileList.push(this)
				}
			}, this)
		} else {
			this._updateParentFileList()
		}
	},

	_updateParentFileList: function (file) {
		if (!file) {
			file = this
		}
		var p = this.parent
		if (p) {
			p.fileList.push(file)
			while (p && !p.isRoot) {
				p.files.push(this)
				p = p.parent
			}
		}
	},

	_eachAccess: function (eachFn, fileFn) {
		if (this.isFolder) {
			utils.each(this.files, function (f, i) {
				return eachFn.call(this, f, i)
			}, this)
			return
		}
		if (!fileFn) {
			fileFn = eachFn
		}
		fileFn.call(this, this)
	},

	bootstrap: function () {
		if (this.isFolder) return
		var opts = this.uploader.opts
		if (utils.isFunction(opts.initFileFn)) {
			opts.initFileFn.call(this, this)
		}

		this.abort(true)
		this.error = false
		// Rebuild stack of chunks from file
		this._prevProgress = 0
		var round = opts.forceChunkSize ? Math.ceil : Math.floor
		var chunks = Math.max(round(this.size / opts.chunkSize), 1)
		for (var offset = 0; offset < chunks; offset++) {
			this.chunks.push(new Chunk(this.uploader, this, offset))
		}
	},

	_measureSpeed: function () {
		var timeSpan = Date.now() - this._lastProgressCallback
		if (!timeSpan) {
			return
		}
		var smoothingFactor = this.uploader.opts.speedSmoothingFactor
		var uploaded = this.sizeUploaded()
		// Prevent negative upload speed after file upload resume
		this.currentSpeed = Math.max((uploaded - this._prevUploadedSize) / timeSpan * 1000, 0)
		this.averageSpeed = smoothingFactor * this.currentSpeed + (1 - smoothingFactor) * this.averageSpeed
		this._prevUploadedSize = uploaded
	},

	_chunkEvent: function (chunk, evt, message) {
		var uploader = this.uploader
		var STATUS = Chunk.STATUS
		switch (evt) {
			case STATUS.PROGRESS:
				if (Date.now() - this._lastProgressCallback < uploader.opts.progressCallbacksInterval) {
					break
				}
				this._measureSpeed()
				uploader._trigger('fileProgress', this, chunk)
				uploader._trigger('progress')
				this._lastProgressCallback = Date.now()
				break
			case STATUS.ERROR:
				this.error = true
				this.abort(true)
				uploader._trigger('fileError', this, message, chunk)
				uploader._trigger('error', message, this, chunk)
				break
			case STATUS.SUCCESS:
				if (this.error) {
					return
				}
				this._measureSpeed()
				uploader._trigger('fileProgress', this, chunk)
				uploader._trigger('progress')
				this._lastProgressCallback = Date.now()
				if (this.isComplete()) {
					this.currentSpeed = 0
					this.averageSpeed = 0
					uploader._trigger('fileSuccess', this, message, chunk)
				}
				break
			case STATUS.RETRY:
				uploader._trigger('fileRetry', this, chunk)
				break
		}
	},

	isComplete: function () {
		var outstanding = false
		this._eachAccess(function (file) {
			if (!file.isComplete()) {
				outstanding = true
				return false
			}
		}, function () {
			var STATUS = Chunk.STATUS
			utils.each(this.chunks, function (chunk) {
				var status = chunk.status()
				if (status === STATUS.PENDING || status === STATUS.UPLOADING || status === STATUS.READING || chunk.preprocessState === 1 || chunk.readState === 1) {
					outstanding = true
					return false
				}
			})
		})
		return !outstanding
	},

	isUploading: function () {
		var uploading = false
		this._eachAccess(function (file) {
			if (file.isUploading()) {
				uploading = true
				return false
			}
		}, function () {
			var uploadingStatus = Chunk.STATUS.UPLOADING
			utils.each(this.chunks, function (chunk) {
				if (chunk.status() === uploadingStatus) {
					uploading = true
					return false
				}
			})
		})
		return uploading
	},

	resume: function () {
		this._eachAccess(function (f) {
			f.resume()
		}, function () {
			this.paused = false
			this.uploader.upload()
		})
	},

	pause: function () {
		this._eachAccess(function (f) {
			f.pause()
		}, function () {
			this.paused = true
			this.abort()
		})
	},

	cancel: function () {
		if (this.isFolder) {
			for (var i = this.files.length - 1; i >= 0; i--) {
				this.files[i].cancel()
			}
			return
		}
		this.uploader.removeFile(this)
	},

	retry: function (file) {
		if (file) {
			file.bootstrap()
		} else {
			this._eachAccess(function (f) {
				f.bootstrap()
			}, function () {
				this.bootstrap()
			})
		}
		this.uploader.upload()
	},

	abort: function (reset) {
		this.currentSpeed = 0
		this.averageSpeed = 0
		var chunks = this.chunks
		if (reset) {
			this.chunks = []
		}
		var uploadingStatus = Chunk.STATUS.UPLOADING
		utils.each(chunks, function (c) {
			if (c.status() === uploadingStatus) {
				c.abort()
				this.uploader.uploadNextChunk()
			}
		}, this)
	},

	progress: function () {
		var totalDone = 0
		var totalSize = 0
		var ret = 0
		this._eachAccess(function (file, index) {
			totalDone += file.progress() * file.size
			totalSize += file.size
			if (index === this.files.length - 1) {
				ret = totalSize > 0 ? totalDone / totalSize : this.isComplete() ? 1 : 0
			}
		}, function () {
			if (this.error) {
				ret = 1
				return
			}
			if (this.chunks.length === 1) {
				this._prevProgress = Math.max(this._prevProgress, this.chunks[0].progress())
				ret = this._prevProgress
				return
			}
			// Sum up progress across everything
			var bytesLoaded = 0
			utils.each(this.chunks, function (c) {
				// get chunk progress relative to entire file
				bytesLoaded += c.progress() * (c.endByte - c.startByte)
			})
			var percent = bytesLoaded / this.size
			// We don't want to lose percentages when an upload is paused
			this._prevProgress = Math.max(this._prevProgress, percent > 0.9999 ? 1 : percent)
			ret = this._prevProgress
		})
		return ret
	},

	getSize: function () {
		var size = 0
		this._eachAccess(function (file) {
			size += file.size
		}, function () {
			size += this.size
		})
		return size
	},

	getFormatSize: function () {
		var size = this.getSize()
		if (size < 1024) {
			return size + ' bytes'
		} else if (size < 1024 * 1024) {
			return (size / 1024.0).toFixed(0) + ' KB'
		} else if (size < 1024 * 1024 * 1024) {
			return (size / 1024.0 / 1024.0).toFixed(1) + ' MB'
		} else {
			return (size / 1024.0 / 1024.0 / 1024.0).toFixed(1) + ' GB'
		}
	},

	sizeUploaded: function () {
		var size = 0
		this._eachAccess(function (file) {
			size += file.sizeUploaded()
		}, function () {
			utils.each(this.chunks, function (chunk) {
				size += chunk.sizeUploaded()
			})
		})
		return size
	},

	timeRemaining: function () {
		var ret = 0
		var sizeDelta = 0
		var averageSpeed = 0
		this._eachAccess(function (file, i) {
			if (!file.paused && !file.error) {
				sizeDelta += file.size - file.sizeUploaded()
				averageSpeed += file.averageSpeed
			}
			if (i === this.files.length - 1) {
				ret = calRet(sizeDelta, averageSpeed)
			}
		}, function () {
			if (this.paused || this.error) {
				ret = 0
				return
			}
			var delta = this.size - this.sizeUploaded()
			ret = calRet(delta, this.averageSpeed)
		})
		return ret
		function calRet (delta, averageSpeed) {
			if (delta && !averageSpeed) {
				return Number.POSITIVE_INFINITY
			}
			if (!delta && !averageSpeed) {
				return 0
			}
			return Math.floor(delta / averageSpeed)
		}
	},

	removeFile: function (file) {
		if (file.isFolder) {
			if (file.parent) {
				file.parent._removeFile(file)
			}
			utils.each(file.files, function (f) {
				this.removeFile(f)
			}, this)
			return
		}
		utils.each(this.files, function (f, i) {
			if (f === file) {
				this.files.splice(i, 1)
				file.abort()
				if (file.parent) {
					file.parent._removeFile(file)
				}
				return false
			}
		}, this)
	},

	_removeFile: function (file) {
		!file.isFolder && utils.each(this.files, function (f, i) {
			if (f === file) {
				this.files.splice(i, 1)
				if (this.parent) {
					this.parent._removeFile(file)
				}
				return false
			}
		}, this)
		file.parent === this && utils.each(this.fileList, function (f, i) {
			if (f === file) {
				this.fileList.splice(i, 1)
				return false
			}
		}, this)
	},

	getType: function () {
		if (this.isFolder) {
			return 'Folder'
		}
		return this.file.type && this.file.type.split('/')[1]
	},

	getExtension: function () {
		if (this.isFolder) {
			return ''
		}
		return this.name.substr((~-this.name.lastIndexOf('.') >>> 0) + 2).toLowerCase()
	}

})

module.exports = File

function parsePaths (path) {
	var ret = []
	var paths = path.split('/')
	var len = paths.length
	var i = 1
	paths.splice(len - 1, 1)
	len--
	if (paths.length) {
		while (i <= len) {
			ret.push(paths.slice(0, i++).join('/') + '/')
		}
	}
	return ret
}

},{"./chunk":1,"./utils":5}],5:[function(_dereq_,module,exports){
var oproto = Object.prototype
var aproto = Array.prototype
var serialize = oproto.toString

var isFunction = function (fn) {
	return serialize.call(fn) === '[object Function]'
}

var isArray = Array.isArray || /* istanbul ignore next */ function (ary) {
	return serialize.call(ary) === '[object Array]'
}

var isPlainObject = function (obj) {
	return serialize.call(obj) === '[object Object]' && Object.getPrototypeOf(obj) === oproto
}

var utils = {

	noop: function () {},
	bind: function (fn, context) {
		return function () {
			return fn.apply(context, arguments)
		}
	},
	preventEvent: function (evt) {
		evt.preventDefault()
	},
	stop: function (evt) {
		evt.preventDefault()
		evt.stopPropagation()
	},
	nextTick: function (fn, context) {
		setTimeout(utils.bind(fn, context), 0)
	},
	toArray: function (ary, start, end) {
		if (start === undefined) start = 0
		if (end === undefined) end = ary.length
		return aproto.slice.call(ary, start, end)
	},

	isPlainObject: isPlainObject,
	isFunction: isFunction,
	isArray: isArray,
	isObject: function (obj) {
		return Object(obj) === obj
	},
	isString: function (s) {
		return typeof s === 'string'
	},
	isUndefined: function (a) {
		return typeof a === 'undefined'
	},
	isDefined: function (a) {
		return typeof a !== 'undefined'
	},

	each: function (ary, func, context) {
		if (utils.isDefined(ary.length)) {
			for (var i = 0, len = ary.length; i < len; i++) {
				if (func.call(context, ary[i], i, ary) === false) {
					break
				}
			}
		} else {
			for (var k in ary) {
				if (func.call(context, ary[k], k, ary) === false) {
					break
				}
			}
		}
	},

	/**
	 * If option is a function, evaluate it with given params
	 * @param {*} data
	 * @param {...} args arguments of a callback
	 * @returns {*}
	 */
	evalOpts: function (data, args) {
		if (utils.isFunction(data)) {
			// `arguments` is an object, not array, in FF, so:
			args = utils.toArray(arguments)
			data = data.apply(null, args.slice(1))
		}
		return data
	},

	extend: function () {
		var options
		var name
		var src
		var copy
		var copyIsArray
		var clone
		var target = arguments[0] || {}
		var i = 1
		var length = arguments.length
		var force = false

		// 如果第一个参数为布尔,判定是否深拷贝
		if (typeof target === 'boolean') {
			force = target
			target = arguments[1] || {}
			i++
		}

		// 确保接受方为一个复杂的数据类型
		if (typeof target !== 'object' && !isFunction(target)) {
			target = {}
		}

		// 如果只有一个参数，那么新成员添加于 extend 所在的对象上
		if (i === length) {
			target = this
			i--
		}

		for (; i < length; i++) {
			// 只处理非空参数
			if ((options = arguments[i]) != null) {
				for (name in options) {
					src = target[name]
					copy = options[name]

					// 防止环引用
					if (target === copy) {
						continue
					}
					if (force && copy && (isPlainObject(copy) || (copyIsArray = isArray(copy)))) {
						if (copyIsArray) {
							copyIsArray = false
							clone = src && isArray(src) ? src : []
						} else {
							clone = src && isPlainObject(src) ? src : {}
						}
						target[name] = utils.extend(force, clone, copy)
					} else if (copy !== undefined) {
						target[name] = copy
					}
				}
			}
		}
		return target
	}
}

module.exports = utils

},{}]},{},[3])
(3)
});