/* global define, brackets, window */

define(function (require, exports, module) {
  var FileSystemWrapper = require('./filesystem')

  var ProjectManager = brackets.getModule('project/ProjectManager')
  var EditorManager = brackets.getModule('editor/EditorManager')
  var FileUtils = brackets.getModule('file/FileUtils')
  var DocumentManager = brackets.getModule('document/DocumentManager')

  var EventEmitter = require('./npm/events').EventEmitter
  var inherits = require('./npm/inherits')
  
  var emptyDelta = {
    from: {
      ch: 0,
      line: 0
    },
    to: {
      ch: 0,
      line: 0
    },
    start: 0,
    origin: '+input',
    removed: [''],
    text: ['']
  }

  inherits(EditorWrapper, EventEmitter)

  function EditorWrapper () {
    var self = this

    self.currentEditor = null
    self._remoteCarets = []
    self._lastSelections = []

    self._mutex = false
    self.currentFilePath = null

    self._onActiveEditorChange = self._onActiveEditorChange.bind(self)
    self._onChange = self._onChange.bind(self)
    self._onSelection = self._onSelection.bind(self)
  }

  EditorWrapper.prototype.setupListeners = function () {
    var self = this

    self.projectPath = ProjectManager.getProjectRoot().fullPath
    self.currentEditor = EditorManager.getActiveEditor()
    EditorManager.on('activeEditorChange', self._onActiveEditorChange)
    self._onActiveEditorChange(null, self.currentEditor, null)
    self.recomputePath()
  }

  EditorWrapper.prototype.removeListeners = function () {
    var self = this

    EditorManager.off('activeEditorChange', self._onActiveEditorChange)
    if (!self.currentEditor) return
    self.currentEditor._codeMirror.off('change', self._onChange)
    self.currentEditor._codeMirror.off('beforeSelectionChange', self._onSelection)
  }

  EditorWrapper.prototype.recomputePath = function () {
    var self = this

    self.currentEditor = EditorManager.getActiveEditor()
    if (!self.currentEditor) return
    self.currentFilePath = FileUtils.getRelativeFilename(
      self.projectPath,
      self.currentEditor.document.file.fullPath
    )
  }

  EditorWrapper.prototype.highlight = function (selections) {
    var self = this
    
    // apply highlight after changes
    window.setTimeout(function () {
      self._lastSelections = selections

      self._remoteCarets.forEach(self._removeRemoteCaret)
      self._remoteCarets = []

      if (!self.currentEditor) return
      self.currentEditor._codeMirror.getAllMarks().forEach(function (mark) {
        mark.clear()
      })

      selections.forEach(function (sel) {
        if (fromWebPath(sel.filePath) !== self.currentFilePath) return

        sel.change.ranges.forEach(function (range) {
          if (self._isNonEmptyRange(range)) {
            self.currentEditor._codeMirror.markText(range.head, range.anchor, {
              className: 'remoteSelection'
            })
          } else {
            self._insertRemoteCaret(range)
          }
        })
      })
    }, 10)
  }
  
  EditorWrapper.prototype._insertRemoteCaret = function (range) {
    var self = this
    
    var caretEl = document.createElement('div')
    if (!self.currentEditor) return
    var cm = self.currentEditor._codeMirror
    
    caretEl.classList.add('remoteCaret')
    caretEl.style.height = cm.defaultTextHeight() + "px"
    caretEl.style.marginTop = "-" + cm.defaultTextHeight() + "px"
     
    self._remoteCarets.push(caretEl)
     
    cm.addWidget(range.anchor, caretEl, false)
  }
  
  EditorWrapper.prototype._removeRemoteCaret = function (caret) {
    var self = this
    caret.parentNode.removeChild(caret)
  }

  EditorWrapper.prototype.change = function (filePath, change, content) {
    var self = this
    
    console.log('remote change', filePath, change)

    if (filePath === self.currentFilePath && self.currentEditor) {
      self._mutex = true
      self.currentEditor._codeMirror.replaceRange(change.text, change.from, change.to)
      self._mutex = false
    } else {
      var absPath = self.projectPath + filePath
      FileSystemWrapper.change(absPath, change)
    }
  }
  
  EditorWrapper.prototype.createFile = function (filePath, content) {
    var self = this
    
    var absPath = self.projectPath + filePath
    console.log('create file ', filePath)
    
    if (filePath === self.currentFilePath && self.currentEditor) {
      self._mutex = true
      self.currentEditor._codeMirror.setValue(content)
      self._mutex = false
    } else {
      FileSystemWrapper.createFile(absPath, content)
    }
  }
  
  EditorWrapper.prototype.createDirectory = function (filePath) {
    var self = this
    
    var absPath = self.projectPath + filePath
    FileSystemWrapper.createDirectory(absPath)
  }
  
  EditorWrapper.prototype.deleteFile = function (filePath) {
    var self = this
    
    var absPath = self.projectPath + filePath
    FileSystemWrapper.deleteFile(absPath)
  }

  EditorWrapper.prototype.open = function () {
    // var self = this
    // TODO: Needed?
  }

  EditorWrapper.prototype.close = function () {
    // var self = this
    // TODO: Needed?
  }

  EditorWrapper.prototype.posFromIndex = function (filePath, index, cb) {
    var self = this

    if (filePath === self.currentFilePath && self.currentEditor) {
      cb(self.currentEditor._codeMirror.posFromIndex(index))
    } else {
      var absPath = self.projectPath + filePath
      DocumentManager.getDocumentForPath(absPath).then(function (doc) {
        doc._ensureMasterEditor()
        cb(doc._masterEditor._codeMirror.posFromIndex(index))
      })
    }
  }
  
  EditorWrapper.prototype.indexFromPos = function (filePath, pos, cb) {
    var self = this
    console.log('indexFromPos')

    if (filePath === self.currentFilePath && self.currentEditor) {
      cb(self.currentEditor._codeMirror.indexFromPos(pos))
    } else {
      var absPath = self.projectPath + filePath
      DocumentManager.getDocumentForPath(absPath).then(function (doc) {
        doc._ensureMasterEditor()
        cb(doc._masterEditor._codeMirror.indexFromPos(pos))
      })
    }
  }

  EditorWrapper.prototype._onActiveEditorChange = function ($event, newEditor, oldEditor) {
    var self = this

    if (self.currentEditor) {
      self.currentEditor._codeMirror.off('change', self._onChange)
      self.currentEditor._codeMirror.off('beforeSelectionChange', self._onSelection)
    }

    if (newEditor) {
      self.recomputePath()
      self.currentEditor._codeMirror.on('change', self._onChange)
      self.currentEditor._codeMirror.on('beforeSelectionChange', self._onSelection)
      self.highlight(self._lastSelections)
      if (self.currentFilePath) self.emit('changeFile', self.currentFilePath, emptyDelta)
    }
  }

  EditorWrapper.prototype._onChange = function (cm, change) {
    var self = this
    
    if (self._mutex || !self.currentFilePath) return
    if (change.origin === 'setValue') return
    
    self.indexFromPos(self.currentFilePath, change.from, function (start) {
      change.start = start
      console.log('local change', self.currentFilePath, change)
      self.emit('changeFile', self.currentFilePath, change)
    })
  }

  EditorWrapper.prototype._onSelection = function (cm, selection) {
    var self = this
    
    if (!self.currentFilePath) return

    var ranges = selection.ranges.map(self._putHeadBeforeAnchor)

    self.emit('changeSelection', self.currentFilePath, {
      ranges: ranges
    })
  }
  
  EditorWrapper.prototype._isNonEmptyRange = function (range) {
    // return true if range contains one or more characters
    return range.head.ch !== range.anchor.ch || range.head.line !== range.anchor.line
  }
  
  EditorWrapper.prototype._putHeadBeforeAnchor = function (range) {
    var nr = JSON.parse(JSON.stringify(range)) // Clone object 
    
    // If anchor is on a greater line, or same line and greater character
    if (nr.head.line > nr.anchor.line || (
      nr.head.line === nr.anchor.line && nr.head.ch > nr.anchor.ch
    )) {
      var temp = nr.head  // swap them
      nr.head = nr.anchor
      nr.anchor = temp
    }
    return nr
  }
  
  /* Utilities to convert path formats */

  function toWebPath (path) {
    return path[0] === '/' ? path : '/' + path
  }

  function fromWebPath (path) {
    return path[0] === '/' ? path.slice(1) : path
  }

  module.exports = new EditorWrapper()
})
