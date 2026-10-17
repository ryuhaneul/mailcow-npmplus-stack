import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import { createFakeApi } from '../../web/dev/fake-api.js';

await test('compose preserves body and caret through typing, composition and draft renders',async t=>{
  const fake=createFakeApi({authenticated:true});
  fake.state.prefs.signatures={};
  const harness=`<!doctype html><html><body><div id="root"></div><script type="module">
    import {h,render,options} from 'preact';
    import {useState} from 'preact/hooks';
    import ComposeEditor from '/src/components/ComposeEditor.jsx';
    const effects=[],renders=[];window.caret={effects,renders};
    options.requestAnimationFrame=callback=>effects.push(callback);
    options.debounceRendering=callback=>renders.push(callback);
    function Harness(){const [html,setHtml]=useState('');window.caret.setHtml=setHtml;return h(ComposeEditor,{html,onChange:setHtml,editor:{current:null}});}
    render(h(Harness),document.getElementById('root'));
    window.caret.flushEffects=()=>{while(effects.length)effects.shift()();};
    window.caret.flushRenders=()=>{while(renders.length)renders.shift()();};
  </script></body></html>`;
  const server=await createServer({configFile:false,root:fileURLToPath(new URL('../../web',import.meta.url)),logLevel:'error',plugins:[preact(),{name:'caret-test-api',configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url==='/caret-harness'){res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/caret-harness',harness));}else fake.middleware(req,res,next);});}}],server:{host:'127.0.0.1',port:0}});
  await server.listen();t.after(()=>server.close());t.after(()=>fake.close());
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});t.after(()=>browser.close());
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  async function open(harness=false,width=1280){
    const page=await browser.newPage({viewport:{width,height:900}});
    await page.goto(origin+(harness?'/caret-harness':'/#compose'));
    const body=page.frameLocator('iframe.compose-editor').locator('body');
    await expect(body).toHaveAttribute('contenteditable','true');await body.click();
    if(harness)await page.evaluate(()=>{caret.flushRenders();caret.flushEffects();});
    return {page,body};
  }
  async function snapshot(body){return body.evaluate(body=>{const selection=body.ownerDocument.getSelection(),range=body.ownerDocument.createRange();range.selectNodeContents(body);if(selection.rangeCount)range.setEnd(selection.anchorNode,selection.anchorOffset);return {text:body.textContent,offset:range.toString().length};});}
  for(const delay of [0,1,10])await t.test(`240 keyboard characters at ${delay}ms retain every character and end caret`,async()=>{
    const {page,body}=await open();try{const text='abcdefghijklmnopqrstuvwxyz1234'.repeat(8);await page.keyboard.type(text,{delay});assert.deepEqual(await snapshot(body),{text,offset:text.length});}finally{await page.close();}
  });
  await t.test('Korean composition events preserve the active text node and final caret',async()=>{
    const {page,body}=await open();try{
      await body.evaluate(body=>{
        const doc=body.ownerDocument,win=doc.defaultView;
        body.dispatchEvent(new win.CompositionEvent('compositionstart',{bubbles:true,data:''}));
        const node=doc.createTextNode('');body.append(node);body._composingNode=node;
      });
      for(const text of ['ㅎ','하','한','한ㄱ','한그','한글']){
        await body.evaluate((body,text)=>{const doc=body.ownerDocument,win=doc.defaultView,node=body._composingNode;node.data=text;const selection=doc.getSelection();selection.collapse(node,text.length);body.dispatchEvent(new win.CompositionEvent('compositionupdate',{bubbles:true,data:text}));body.dispatchEvent(new win.InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:text,isComposing:true}));},text);
        await page.waitForTimeout(40);
        assert.equal(await body.evaluate(body=>body.contains(body._composingNode)),true);
        assert.deepEqual(await snapshot(body),{text,offset:text.length});
      }
      await body.evaluate(body=>{const win=body.ownerDocument.defaultView;body.dispatchEvent(new win.CompositionEvent('compositionend',{bubbles:true,data:'한글'}));body.dispatchEvent(new win.InputEvent('input',{bubbles:true,inputType:'insertText',data:'한글'}));});
      await page.keyboard.type(' done');assert.deepEqual(await snapshot(body),{text:'한글 done',offset:7});
    }finally{await page.close();}
  });
  await t.test('an earlier render echo cannot replace newer DOM input before the next render',async()=>{
    const {page,body}=await open(true);try{
      const result=await body.evaluate(body=>{const doc=body.ownerDocument,win=doc.defaultView,host=win.parent.caret;doc.execCommand('insertText',false,'a');host.flushRenders();doc.execCommand('insertText',false,'b');const before=body.textContent;host.flushEffects();const after=body.textContent;host.flushRenders();host.flushEffects();return {before,after};});
      assert.deepEqual(result,{before:'ab',after:'ab'});assert.deepEqual(await snapshot(body),{text:'ab',offset:2});
    }finally{await page.close();}
  });
  await t.test('external HTML during composition cannot replace the composing node',async()=>{
    const {page,body}=await open(true);try{
      await body.evaluate(body=>{const doc=body.ownerDocument,win=doc.defaultView,host=win.parent.caret;body.dispatchEvent(new win.CompositionEvent('compositionstart',{bubbles:true}));const node=doc.createTextNode('한');body.append(node);doc.getSelection().collapse(node,1);body._composingNode=node;host.setHtml('<p>outside</p>');host.flushRenders();host.flushEffects();});
      assert.equal(await body.evaluate(body=>body.contains(body._composingNode)),true);assert.deepEqual(await snapshot(body),{text:'한',offset:1});
      await body.evaluate(body=>body.dispatchEvent(new body.ownerDocument.defaultView.CompositionEvent('compositionend',{bubbles:true,data:'한'})));
    }finally{await page.close();}
  });
  await t.test('typing across a delayed three-second autosave response preserves caret, body and iframe',async()=>{
    const {page,body}=await open();try{
      let release;const gate=new Promise(resolve=>release=resolve);
      await page.route('**/api/drafts',async route=>{await gate;await route.continue();});
      await page.keyboard.type('before-save');
      const request=page.waitForRequest(req=>req.url().endsWith('/api/drafts'));
      await request;
      await body.evaluate(body=>{body._original=body;body.ownerDocument.defaultView.frameElement._originalDoc=body.ownerDocument;});
      const text='abcdefghijklmnopqrstuvwxyz'.repeat(10);
      const typing=page.keyboard.type(text,{delay:10});
      await page.waitForTimeout(500);release();await typing;
      await expect(page.locator('.saved')).toContainText('임시 저장됨');
      assert.deepEqual(await snapshot(body),{text:'before-save'+text,offset:11+text.length});
      assert.equal(await body.evaluate(body=>body===body._original&&body.ownerDocument===body.ownerDocument.defaultView.frameElement._originalDoc),true);
    }finally{await page.close();}
  });
  await t.test('HTML source and formatting still update the editor at desktop, tablet and mobile widths',async()=>{
    const captures=process.env.COMPOSE_CARET_CAPTURE_DIR;if(captures)await mkdir(captures,{recursive:true});
    for(const width of [1280,768,375]){
      const {page,body}=await open(false,width);try{
        await page.getByRole('button',{name:'HTML 원문',exact:true}).click();
        await page.getByRole('textbox',{name:'HTML 원문 편집',exact:true}).fill('<p>외부 HTML</p><blockquote>인용</blockquote>');
        await expect(body).toHaveText('외부 HTML인용');
        await page.getByRole('button',{name:'HTML 원문',exact:true}).click();
        await body.click();await page.keyboard.press('Control+End');await page.getByRole('button',{name:'굵게',exact:true}).click();await page.keyboard.type('bold');await expect(body.locator('b,strong')).toHaveText('bold');
        if(captures)await page.screenshot({path:`${captures}/compose-caret-${width}.png`});
      }finally{await page.close();}
    }
  });
});
