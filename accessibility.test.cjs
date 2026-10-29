const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
function setup(){return new JSDOM(fs.readFileSync('web/index.html','utf8'),{runScripts:'outside-only',url:'http://localhost/'});}
test('dialog traps keyboard focus and Escape restores its trigger',async()=>{
 const d=setup(),w=d.window,doc=w.document;
 w.HTMLElement.prototype.getClientRects=function(){return [{}]};
 w.eval(fs.readFileSync('web/accessibility.js','utf8'));
 const trigger=doc.createElement('button');doc.body.append(trigger);trigger.focus();
 const panel=doc.querySelector('.overlay');panel.hidden=false;
 await new Promise(r=>setImmediate(r));
 assert.equal(panel.getAttribute('role'),'dialog');assert.ok(panel.contains(doc.activeElement));
 doc.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));assert.ok(panel.contains(doc.activeElement));
 doc.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
 await new Promise(r=>setImmediate(r));assert.equal(panel.hidden,true);assert.equal(doc.activeElement,trigger);w.close();
});
test('text questions preserve offline drafts, send connected text and render captions safely',()=>{
 const d=setup(),w=d.window,doc=w.document,sent=[];
 w.$=id=>doc.getElementById(id);w.streaming=false;w.ws={readyState:1,send:s=>sent.push(JSON.parse(s))};w.setStatus=()=>{};
 w.eval(fs.readFileSync('web/app.js','utf8').slice(fs.readFileSync('web/app.js','utf8').indexOf('let transcriptRole = null;')));
 const input=w.$('textQuestion'),form=w.$('textQuestionForm');input.value='<img src=x onerror=bad()>hello';
 form.dispatchEvent(new w.Event('submit',{cancelable:true}));assert.equal(sent.length,0);assert.ok(input.value);
 w.streaming=true;form.dispatchEvent(new w.Event('submit',{cancelable:true}));assert.equal(sent.length,1);assert.equal(input.value,'');assert.equal(w.$('liveCaptions').querySelector('img'),null);assert.match(w.$('liveCaptions').textContent,/hello/);
 w.$('captionsToggle').click();assert.equal(w.$('liveCaptions').hidden,true);assert.equal(w.$('captionsToggle').getAttribute('aria-pressed'),'false');w.close();
});
