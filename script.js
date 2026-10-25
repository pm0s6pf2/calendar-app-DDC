'use strict';
// 同じGoogle Cloudプロジェクトの公開用設定を指定する。client secretは書かない。
const CONFIG = {
  clientId: '432542663306-gajl9s636n960rmul1a630e2k9lchdl3.apps.googleusercontent.com',
  projectNumber: '432542663306',
  pickerApiKey: '', // ウェブサイト制限・API制限を設定したブラウザ用キー
};
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file';
const HEADERS = {
  Diary: ['entry_id', 'file_id', 'calendar_date', 'text', 'updated_at'],
  Favorites: ['event_id', 'file_id', 'favorite', 'registered_at', 'updated_at'],
};
const $ = selector => document.querySelector(selector);
const state = {
  live: false, token: '', expires: 0, epoch: 0, user: '', folder: '', sheet: '',
  files: [], date: '2026-10-25', favorites: new Set(), diary: new Map(),
  filter: 'all', history: [], timer: null, sliding: false, renderId: 0, objectURL: null,
  selectedId: '', pendingSwap: null, busy: false, dirty: false, editing: null, draftId: null, gisReady: false, pickerReady: false,
};
const samples = [
  ['a','2026-10-25','2026-10-25','小さな一歩を、大切に。'],
  ['b','2026-10-24','2026-10-23','立ち止まる日があっても。'],
  ['c','2026-10-26','2026-10-26','今日の発見を、ひとつ。'],
  ['d','2025-10-25','2025-10-25','自分の歩幅で、進もう。'],
  ['e','2024-10-25','2024-10-25','いつもの景色に、新しい目を。'],
  ['f','2024-02-29','2024-02-29','四年に一度の、この一日。'],
];
function status(message) { $('#status').textContent = message; }
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value+'T12:00:00Z')) &&
    new Date(value+'T12:00:00Z').toISOString().slice(0,10) === value;
}
function imageDate(name) { const m = /^(\d{4}-\d{2}-\d{2})\.(png|jpe?g)$/i.exec(name); return m && validDate(m[1]) ? m[1] : null; }
function current() { return state.files.find(f=>f.id===state.selectedId && f.date===state.date) || state.files.find(f=>f.date===state.date); }
function safeToLeave() { return !state.dirty || confirm('未保存の日記があります。変更を破棄して移動しますか？'); }
function settingsKey() { return 'himekuri-settings-'+state.user; }
function remember() {
  try { localStorage.setItem(settingsKey(),JSON.stringify({folder:state.folder,sheet:state.sheet})); }
  catch { status('接続先の設定をブラウザに保存できませんでした。'); }
}
function showError(error) { status(error.message || '処理に失敗しました。'); }
async function run(action) {
  if (state.busy) return;
  stop(); state.busy = true; controls();
  try { await action(); } catch (e) { showError(e); }
  finally { state.busy = false; controls(); }
}
function controls() {
  $('#connect').disabled = state.busy || !state.gisReady || !state.pickerReady;
  $('#connect').hidden = state.live && Date.now()<state.expires;
  $('#disconnect').hidden = !state.live;
  for (const id of ['disconnect','chooseFolder','chooseSheet','createSheet','sync']) $('#'+id).disabled = state.busy || !state.live;
  const file = current();
  $('#edit').disabled = state.busy || !file || !!state.pendingSwap;
  $('#deleteDiary').disabled = state.busy || !file || !state.diary.has(file.id) || (state.live && !state.sheet);
  $('#recoverSwap').hidden = !state.pendingSwap; $('#recoverSwap').disabled=state.busy;
  $('#chooseFolder').disabled ||= !!state.pendingSwap;
  $('#favorite').disabled = state.busy || !file || (state.live && !state.sheet);
  $('#saveDiary').disabled = state.busy || !file || (state.live && !state.sheet);
  $('#undo').disabled = state.busy || !state.history.length || !!state.pendingSwap;
  for (const id of ['prev','next','yearPrev','yearNext','today','leap','reset','play']) $('#'+id).disabled=state.busy;
  $('#diary').disabled = state.busy || !file;
  $('#sheetLink').hidden = !state.sheet;
  if (state.sheet) $('#sheetLink').href='https://docs.google.com/spreadsheets/d/'+encodeURIComponent(state.sheet)+'/edit';
  $('#favorite').textContent = file && state.favorites.has(file.id) ? '★ 登録済み' : '☆ お気に入り';
  $('#favorite').setAttribute('aria-pressed',String(!!file && state.favorites.has(file.id)));
}
async function api(url, options={}) {
  const epoch=state.epoch;
  if (!state.token || Date.now()>=state.expires) { controls(); throw Error('接続期限が切れました。「Googleに接続」で再接続してください。'); }
  const response=await fetch(url,{...options,headers:{Authorization:'Bearer '+state.token,...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});
  if (epoch!==state.epoch) throw Error('接続が変更されたため処理を中止しました。');
  if (!response.ok) {
    if (response.status===401) {state.expires=0; stop(); controls();}
    let detail='';try {detail=(await response.json()).error?.message||'';}catch{}
    throw Error(`Google API ${response.status}: ${detail || '通信に失敗しました。'}${response.status===401?' 再接続してください。':''}`);
  }
  return response;
}
async function json(url, options) {return (await api(url,options)).json();}
const escapeQuery = s=>s.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
async function list(q) {
  const files=[];let token;
  do {
    const p=new URLSearchParams({q,pageSize:'1000',fields:'nextPageToken,incompleteSearch,files(id,name,mimeType,capabilities(canRename))',supportsAllDrives:'true',includeItemsFromAllDrives:'true'});
    if(token)p.set('pageToken',token);
    const result=await json('https://www.googleapis.com/drive/v3/files?'+p);
    if(result.incompleteSearch)throw Error('一覧の一部を取得できませんでした。');
    files.push(...(result.files||[]));token=result.nextPageToken;
  }while(token);
  return files;
}
async function loadFolder() {
  if(!state.folder)return;
  const files=await list(`'${escapeQuery(state.folder)}' in parents and trashed=false`);
  state.files=files.filter(f=>imageDate(f.name)).map(f=>({...f,date:imageDate(f.name)})).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  $('#folderName').textContent=`Google Drive · ${state.files.length}枚`;
  const counts=new Map();for(const f of state.files)counts.set(f.date,(counts.get(f.date)||0)+1);
  if([...counts.values()].some(n=>n>1))status('同じ日付の画像が複数あります。日付検索では先頭の画像を表示します。');
}
function picker(kind, fileId) {
  if (!CONFIG.pickerApiKey) throw Error('script.jsのpickerApiKeyを設定してください。');
  if(Date.now()>=state.expires)throw Error('Googleに再接続してください。');
  return new Promise((resolve,reject)=>{
    let view=new google.picker.DocsView(google.picker.ViewId.DOCS);
    if(kind==='folder')view.setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder');
    else if(kind==='sheet')view.setMimeTypes('application/vnd.google-apps.spreadsheet');
    else view.setMimeTypes('image/png,image/jpeg').setFileIds([fileId]);
    const builder=new google.picker.PickerBuilder().addView(view).setOAuthToken(state.token)
      .setDeveloperKey(CONFIG.pickerApiKey).setAppId(CONFIG.projectNumber).setOrigin(location.origin)
      .setTitle(kind==='image'?'名前を修正する画像を選択して許可':'対象を選択')
      .setCallback(data=>{
        if(data.action===google.picker.Action.CANCEL)resolve(null);
        if(data.action===google.picker.Action.PICKED){const doc=data.docs[0];if(fileId&&doc.id!==fileId)reject(Error('表示中の画像と異なる画像が選択されました。'));else resolve(doc);}
      });
    builder.build().setVisible(true);
  });
}
function googleIdentityReady(){state.gisReady=true;controls();}
function googlePickerReady(){gapi.load('picker',()=>{state.pickerReady=true;controls();});}
function connect() {
  if(!safeToLeave())return;
  if(!CONFIG.pickerApiKey){status('Google接続にはscript.jsのpickerApiKey設定が必要です。README.mdを確認してください。');return;}
  if(location.protocol==='file:'){status('Google連携はlocalhostまたはHTTPSで開いてください。README.mdを確認してください。');return;}
  stop();state.busy=true;controls();const epoch=++state.epoch;
  const client=google.accounts.oauth2.initTokenClient({client_id:CONFIG.clientId,scope:SCOPES,
    callback:async response=>{
      if(epoch!==state.epoch)return;
      try {
        if(response.error)throw Error('Google認証: '+response.error);
        if(!google.accounts.oauth2.hasGrantedAllScopes(response,...SCOPES.split(' ')))throw Error('閲覧と保存に必要な権限が許可されていません。');
        state.token=response.access_token;state.expires=Date.now()+Number(response.expires_in)*1000-30000;
        const account=await json('https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)');
        state.user=account.user.permissionId;state.pendingSwap=null;try{state.pendingSwap=JSON.parse(localStorage.getItem('himekuri-swap-'+state.user)||'null');}catch{}state.live=true;state.sheet='';state.folder='';state.history=[];state.files=[];state.diary=new Map();state.favorites=new Set();state.dirty=false;
        $('#connectionStatus').textContent='接続中: '+account.user.emailAddress;
        let settings={};try{settings=JSON.parse(localStorage.getItem(settingsKey())||'{}');}catch{}
        state.folder=typeof settings.folder==='string'?settings.folder:'';
        state.sheet=typeof settings.sheet==='string'?settings.sheet:'';
        await loadFolder();if(state.sheet)await loadRecords();
        status(state.pendingSwap?'中断した入れ替えがあります。復旧ボタンから状態を確認してください。':'接続しました。画像フォルダと保存先を選んでください。');
      }catch(e){showError(e);}
      finally {state.busy=false;render();}
    },error_callback:()=>{state.busy=false;controls();status('接続を中断しました。');}});
  try{client.requestAccessToken({prompt:''});}catch(e){state.busy=false;controls();showError(e);}
}
function disconnect() {
  if(!safeToLeave())return;
  ++state.epoch;state.pendingSwap=null;state.token='';state.expires=0;state.live=false;state.user='';state.sheet='';state.folder='';
  $('#connectionStatus').textContent='デモモード · Google未接続';demo();
}
function sheetURL(suffix=''){return 'https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(state.sheet)+suffix;}
async function validateSheet() {
  const result=await json(sheetURL('/values:batchGet?'+new URLSearchParams({ranges:'Diary!A1:E1'})));
  const first=result.valueRanges?.[0]?.values?.[0];
  const second=(await json(sheetURL('/values/'+encodeURIComponent('Favorites!A1:E1')))).values?.[0];
  if(JSON.stringify(first)!==JSON.stringify(HEADERS.Diary)||JSON.stringify(second)!==JSON.stringify(HEADERS.Favorites))throw Error('この保存先は対応形式ではありません。アプリで作成したスプレッドシートを選んでください。');
}
function latestRows(rows) {
  // 追記ログの末尾が最新。過去の行を残し、書込失敗時の無条件再送はしない。
  const map=new Map();for(const row of rows||[])if(row[1])map.set(row[1],row);return map;
}
async function loadRecords() {
  await validateSheet();
  const p=new URLSearchParams();p.append('ranges','Diary!A2:E');p.append('ranges','Favorites!A2:E');
  const data=await json(sheetURL('/values:batchGet?'+p));
  state.diary=latestRows(data.valueRanges?.[0]?.values);
  state.favorites=new Set([...latestRows(data.valueRanges?.[1]?.values)].filter(([,r])=>r[2]==='TRUE').map(([id])=>id));
}
async function createSheet() {
  if(!safeToLeave())return;
  if(!confirm('日記とお気に入り用のスプレッドシートをGoogle Driveに新規作成しますか？'))return;
  const result=await json('https://sheets.googleapis.com/v4/spreadsheets',{method:'POST',body:JSON.stringify({properties:{title:'日めくり — 日記とお気に入り'},sheets:[{properties:{title:'Diary'}},{properties:{title:'Favorites'}}]})});
  state.sheet=result.spreadsheetId;remember();controls();
  await json(sheetURL('/values:batchUpdate'),{method:'POST',body:JSON.stringify({valueInputOption:'RAW',data:Object.entries(HEADERS).map(([name,row])=>({range:name+'!A1:E1',values:[row]}))})});
  await loadRecords();state.dirty=false;render();status('保存先を作成しました。別端末では「既存の保存先を選ぶ」で同じファイルを選択してください。');
}
async function appendRecord(tab,row) {
  if(!state.sheet)throw Error('日記とお気に入りの保存先を選んでください。');
  await validateSheet();
  try {
    await json(sheetURL('/values/'+encodeURIComponent(tab+'!A:E')+':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS'),{method:'POST',body:JSON.stringify({values:[row]})});
  }catch(e){throw Error(e.message+' 保存結果が不明な場合は、スプレッドシートを確認してから再操作してください。');}
}
async function saveDiary() {
  const file=current();if(!file)return;
  const text=$('#diary').value;
  if(text.length>45000)throw Error('日記は45,000文字以内にしてください。');
  const row=[crypto.randomUUID(),file.id,state.date,text,new Date().toISOString()];
  if(state.live)await appendRecord('Diary',row);
  state.diary.set(file.id,row);state.dirty=false;$('#diaryStatus').textContent=state.live?'Googleに保存済み':'デモ内に保存済み';
  status(state.live?'日記をスプレッドシートに保存しました。':'デモの日記を保存しました。ページを閉じると消えます。');
}
async function favorite() {
  const file=current();if(!file)return;
  const adding=!state.favorites.has(file.id), now=new Date().toISOString();
  if(state.live)await appendRecord('Favorites',[crypto.randomUUID(),file.id,adding?'TRUE':'FALSE',adding?now:'',now]);
  if(adding)state.favorites.add(file.id);else state.favorites.delete(file.id);
  controls();renderList();status(adding?'お気に入りに登録しました。':'お気に入りを解除しました。');
}
async function openEdit() {
  if(!safeToLeave())return;
  stop();const file=current();if(!file)return;
  if(state.live){const picked=await picker('image',file.id);if(!picked)return;}
  state.editing={id:file.id,old:file.name};$('#swapNames').checked=false;
  $('#before').textContent=file.name;$('#newDate').value=file.date;
  $('#renameNotice').textContent=state.live?'適用すると、Google Drive上の実際のファイル名が変わります。':'サンプルのみ変更します。';
  validateRename();$('#dialog').showModal();
}
function swapTarget() {
  return state.files.filter(f=>f.id!==state.editing?.id && f.date===$('#newDate').value);
}
function validateRename() {
  const value=$('#newDate').value, file=state.files.find(f=>f.id===state.editing?.id);
  const name=value+(file?.name.match(/\.[^.]+$/)?.[0]||'.png');
  $('#after').textContent=name;
  const targets=swapTarget();
  $('#swapOption').hidden=targets.length!==1;
  $('#swapPreview').hidden=targets.length!==1;
  if(targets.length===1&&file){const other=targets[0];$('#swapPreview').textContent=
    `画像A: ${file.name} → ${name}\n画像B: ${other.name} → ${file.date}${other.name.match(/\.[^.]+$/)[0]}\n画像と日記の組み合わせは変わりません。`;}
  let error='';
  if(state.pendingSwap)error='中断した入れ替えを復旧してください。';
  else if(!validDate(value))error='実在する日付を選んでください。';
  else if(!file||value===file.date)error='変更前と同じ日付です。';
  else if(targets.length>1)error='変更先に複数の画像があり、交換対象を特定できません。';
  else if(targets.length===1&&!$('#swapNames').checked)error='入れ替える場合はチェックしてください。';
  $('#error').textContent=error;$('#apply').disabled=!!error;
  $('#apply').textContent=targets.length===1?'2枚の日付を入れ替える':'変更を適用';
  return !error;
}
async function renameFile(file,newName,expectedName) {
  if(state.live){
    const latest=await json('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(file.id)+'?fields=id,name,capabilities(canRename)&supportsAllDrives=true');
    if(latest.name!==expectedName)throw Error('別の操作でファイル名が変更されています。再読み込みしてください。');
    if(!latest.capabilities?.canRename)throw Error('この画像の名前を変更する権限がありません。');
    const date=imageDate(newName);
    const siblings=await list(`'${escapeQuery(state.folder)}' in parents and trashed=false`);
    if(siblings.some(f=>f.id!==file.id&&imageDate(f.name)===date))throw Error('同じ日付の画像がDriveにあります。');
    await json('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(file.id)+'?supportsAllDrives=true&fields=id,name',{method:'PATCH',body:JSON.stringify({name:newName})});
  }
  file.name=newName;file.date=imageDate(newName);state.date=file.date;state.selectedId=file.id;
}
async function applyRename() {
  if(!validateRename())return;
  const file=state.files.find(f=>f.id===state.editing.id),old=file.name,newName=$('#after').textContent;
  $('#apply').disabled=true;
  try{
    const targets=swapTarget();
    if(targets.length===1){
      if(file.name!==state.editing.old)throw Error('表示中の名前が変わりました。再読み込みしてください。');
      const other=targets[0];if(state.live){const picked=await picker('image',other.id);if(!picked)return;}
      if(!confirm('2枚の日付を入れ替えます。\n'+$('#swapPreview').textContent))return;
      const originalOther=other.name;await swapFiles(file,other);state.history.push({swap:true,a:file.id,b:other.id,aFinal:file.name,bFinal:other.name});
    }else{await renameFile(file,newName,state.editing.old);state.history.push({id:file.id,old,newName});}state.dirty=false;$('#dialog').close();render();
    status('ファイル名を変更しました。日記とお気に入りは同じ画像IDに関連したままです。');
  }finally{if(state.pendingSwap)$('#dialog').close();else if($('#dialog').open)validateRename();}
}
async function undoRename() {
  if(!safeToLeave())return;
  const last=state.history.at(-1);
  if(last?.swap){const a=state.files.find(f=>f.id===last.a),b=state.files.find(f=>f.id===last.b);
    if(!a||!b||a.name!==last.aFinal||b.name!==last.bFinal)throw Error('画像名が変更されています。再読み込みしてください。');
    if(!confirm('直前の2枚の日付入れ替えを取り消しますか？'))return;await swapFiles(a,b);state.history.pop();render();status('入れ替えを取り消しました。');return;}
  const h=state.history.at(-1), file=state.files.find(f=>f.id===h?.id);if(!file)return;
  if(!confirm(h.newName+' を '+h.old+' に戻しますか？'))return;
  await renameFile(file,h.old,h.newName);state.history.pop();state.dirty=false;render();status('名前の変更を取り消しました。');
}
function renderList() {
  $('#list').replaceChildren();
  const list=state.files.filter(f=>(state.filter!=='same'||f.date.slice(5)===state.date.slice(5))&&(state.filter!=='favorite'||state.favorites.has(f.id)));
  for(const file of list){const button=document.createElement('button');button.className='item'+(file===current()?' sel':'');
    const thumb=document.createElement('span');thumb.className='thumb';thumb.textContent=(file.printed||file.date).slice(5).replace('-',' / ');
    const info=document.createElement('span'),title=document.createElement('strong'),sub=document.createElement('span');
    title.textContent=(state.favorites.has(file.id)?'★ ':'')+file.name;sub.className='muted';sub.textContent=state.live?'Google Drive':'サンプル画像';
    info.append(title,sub);button.append(thumb,info);button.onclick=()=>{if(state.busy||!safeToLeave())return;stop();state.date=file.date;state.selectedId=file.id;state.dirty=false;render();};$('#list').append(button);}
  if(!list.length)$('#list').textContent='該当する画像はありません。';
}
async function render() {
  const id=++state.renderId,epoch=state.epoch,file=current();controls();renderList();
  $('#title').textContent=state.date.replaceAll('-',' / ');$('#position').textContent=state.date;
  $('#filename').textContent=file?.name||'NotFound';$('#detail').textContent=!validDate(state.date)?'この年に、この日付はありません。':file?'日めくりアーカイブ':'この日の画像は登録されていません。';
  $('#diary').value=file?(state.diary.get(file.id)?.[3]||''):'';state.dirty=false;
  const saved=file&&state.diary.get(file.id);
  $('#diaryStatus').textContent=saved?`保存済み（保存時の日付 ${saved[2]}）`:'未保存';
  if(state.objectURL){URL.revokeObjectURL(state.objectURL);state.objectURL=null;}
  $('#paper').replaceChildren();$('#paper').className=state.live&&file?'':'paper';
  if(!file){const p=document.createElement('strong');p.textContent='NotFound';$('#paper').append(p);return;}
  if(!state.live){for(const [cl,text] of [['month',file.printed.slice(0,7)],['num',file.printed.slice(8)],['quote',file.quote]]){const p=document.createElement('div');p.className=cl;p.textContent=text;$('#paper').append(p);}return;}
  try{
    $('#paper').textContent='読み込み中…';
    const response=await api('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(file.id)+'?alt=media&supportsAllDrives=true');
    const blob=await response.blob();if(id!==state.renderId||epoch!==state.epoch)return;
    state.objectURL=URL.createObjectURL(blob);const img=document.createElement('img');img.className='drive-photo';img.src=state.objectURL;img.alt=file.name;
    img.onerror=()=>{if(id===state.renderId)status('画像を描画できません。形式を確認してください。');};$('#paper').replaceChildren(img);
  }catch(e){if(id===state.renderId){$('#paper').textContent='画像を取得できません';showError(e);}}
}
function stop(){state.sliding=false;clearTimeout(state.timer);state.timer=null;$('#play').textContent='▶';}
function move(days,years=0){if(!safeToLeave())return;stop();
  if(years){const [y,m,d]=state.date.split('-');state.date=String(+y+years).padStart(4,'0')+'-'+m+'-'+d;}
  else{const date=new Date(state.date+'T12:00:00Z');if(validDate(state.date))date.setUTCDate(date.getUTCDate()+days);else if(days<0)date.setUTCDate(date.getUTCDate()-1);state.date=date.toISOString().slice(0,10);}
  render();
}
async function slide(){if(!state.sliding)return;const dates=[...new Set(state.files.map(f=>f.date))].sort();if(!dates.length){stop();return;}state.date=dates[(dates.indexOf(state.date)+1)%dates.length];await render();if(state.sliding)state.timer=setTimeout(slide,+$('#speed').value);}
function demo(){stop();state.history=[];state.dirty=false;state.date='2026-10-25';state.diary=new Map();state.favorites=new Set();state.files=samples.map(([id,date,printed,quote])=>({id,date,printed,quote,name:date+'.png'}));$('#folderName').textContent='サンプルフォルダ · 6枚';render();}
$('#connect').onclick=connect;$('#disconnect').onclick=disconnect;
$('#chooseFolder').onclick=()=>run(async()=>{if(!safeToLeave())return;stop();const doc=await picker('folder');if(!doc)return;state.folder=doc.id;remember();await loadFolder();render();});
$('#createSheet').onclick=()=>run(createSheet);
$('#chooseSheet').onclick=()=>run(async()=>{if(!safeToLeave())return;const doc=await picker('sheet');if(!doc)return;const old=state.sheet;state.sheet=doc.id;try{await loadRecords();remember();render();}catch(e){state.sheet=old;throw e;}});
$('#sync').onclick=()=>run(async()=>{if(!safeToLeave())return;stop();await loadFolder();if(state.sheet)await loadRecords();render();status('最新の状態を読み込みました。');});
$('#edit').onclick=()=>run(openEdit);$('#newDate').oninput=()=>{$('#swapNames').checked=false;validateRename();};$('#swapNames').onchange=validateRename;$('#cancel').onclick=()=>{if(!state.busy)$('#dialog').close();};$('#apply').onclick=()=>run(applyRename);$('#undo').onclick=()=>run(undoRename);
$('#dialog').addEventListener('cancel',e=>{if(state.busy)e.preventDefault();});
$('#deleteDiary').onclick=()=>run(deleteDiary);$('#recoverSwap').onclick=()=>run(recoverSwap);
$('#favorite').onclick=()=>run(favorite);$('#saveDiary').onclick=()=>run(saveDiary);
$('#diary').oninput=()=>{stop();state.dirty=true;$('#diaryStatus').textContent='未保存の変更があります';};
window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue='';}});
$('#prev').onclick=()=>move(-1);$('#next').onclick=()=>move(1);$('#yearPrev').onclick=()=>move(0,-1);$('#yearNext').onclick=()=>move(0,1);
$('#today').onclick=()=>{if(!safeToLeave())return;stop();const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());state.date=['year','month','day'].map(k=>p.find(x=>x.type===k).value).join('-');render();};
$('#leap').onclick=()=>{if(safeToLeave()){stop();state.date='2026-02-29';render();}};
$('#reset').onclick=()=>{if(state.live){status('Google接続中です。デモへ戻る場合は切断してください。');return;}if(safeToLeave())demo();};
$('#search').onsubmit=e=>{e.preventDefault();if(state.busy||!safeToLeave())return;const value=$('#query').value.trim().replaceAll('/','-');if(!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)){status('YYYY-MM-DD形式で入力してください。');return;}stop();state.date=value;render();};
for(const [id,filter] of [['all','all'],['same','same'],['favoritesOnly','favorite']])$('#'+id).onclick=()=>{state.filter=filter;for(const key of ['all','same','favoritesOnly'])$('#'+key).classList.toggle('active',key===id);renderList();};
$('#play').onclick=()=>{if(state.sliding){stop();return;}if(!safeToLeave())return;state.sliding=true;$('#play').textContent='Ⅱ';state.timer=setTimeout(slide,+$('#speed').value);};
$('#full').onclick=()=>$('#player').classList.toggle('fullscreen');document.addEventListener('keydown',e=>{if(e.key==='Escape')$('#player').classList.remove('fullscreen');});
demo();

// 入れ替えはDrive上で原子的に実行できない。開始前に復旧情報を保存する。
function saveSwap(plan) {
  if(state.live) {
    if(plan)localStorage.setItem('himekuri-swap-'+state.user,JSON.stringify(plan));
    else localStorage.removeItem('himekuri-swap-'+state.user);
  }
  state.pendingSwap=plan;controls();
}
async function fileMetadata(id) {
  if(!state.live)return {...state.files.find(f=>f.id===id),capabilities:{canRename:true}};
  return json('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?fields=id,name,trashed,parents,capabilities(canRename)&supportsAllDrives=true');
}
async function patchName(id,name,expected) {
  const before=await fileMetadata(id);
  if(before.name!==expected||before.trashed||!before.capabilities?.canRename)throw Error('名前または変更権限が変わりました。処理を中止しました。');
  if(state.live)await json('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?supportsAllDrives=true&fields=id,name',{method:'PATCH',body:JSON.stringify({name})});
  // ローカルの一覧更新は2枚の確定後にまとめて行う。
}
function applyPair(plan,original=false) {
  for(const [id,name] of [[plan.a,original?plan.aOld:plan.aNew],[plan.b,original?plan.bOld:plan.bNew]]) {
    const file=state.files.find(f=>f.id===id);if(file){file.name=name;file.date=imageDate(name);}
  }
  state.date=imageDate(original?plan.aOld:plan.aNew);state.selectedId=plan.a;
}
async function swapFiles(a,b) {
  if(state.pendingSwap)throw Error('中断した入れ替えを先に復旧してください。');
  const plan={a:a.id,b:b.id,aOld:a.name,bOld:b.name,
    aNew:b.date+a.name.match(/\.[^.]+$/)[0],bNew:a.date+b.name.match(/\.[^.]+$/)[0],
    temp:'__himekuri_swap_'+crypto.randomUUID()+a.name.match(/\.[^.]+$/)[0],folder:state.folder};
  if(state.live){
    const aa=await fileMetadata(a.id),bb=await fileMetadata(b.id);
    if(aa.name!==a.name||bb.name!==b.name||!aa.capabilities?.canRename||!bb.capabilities?.canRename||aa.trashed||bb.trashed)throw Error('名前または権限が変わりました。再読み込みしてください。');
    if(!aa.parents?.includes(state.folder)||!bb.parents?.includes(state.folder))throw Error('画像が別フォルダに移動されています。');
    const all=await list(`'${escapeQuery(state.folder)}' in parents and trashed=false`);
    if(all.some(f=>f.id!==a.id&&f.id!==b.id&&[a.date,b.date].includes(imageDate(f.name))))throw Error('交換する日付に別の画像があります。');
    saveSwap(plan); // 保存できなければDriveを変更しない
    try{
      await patchName(a.id,plan.temp,plan.aOld);
      await patchName(b.id,plan.bNew,plan.bOld);
      await patchName(a.id,plan.aNew,plan.temp);
    }catch(e){
      // 通信エラーでも変更済みの場合がある。状態を読み直して確定する。
      try {const aa=await fileMetadata(a.id),bb=await fileMetadata(b.id);
        if(aa.name===plan.aNew&&bb.name===plan.bNew){applyPair(plan);saveSwap(null);return;}
      }catch{}
      throw Error('入れ替えが中断されました。画面の「中断した入れ替えを復旧」を使用してください。 '+e.message);
    }
  }
  applyPair(plan);saveSwap(null);
}
async function recoverSwap() {
  const p=state.pendingSwap;if(!p)return;
  if(!confirm('2枚の現在の名前を確認し、入れ替え開始前の名前に戻します。続けますか？'))return;
  const a=await fileMetadata(p.a),b=await fileMetadata(p.b);
  if(![p.aOld,p.temp,p.aNew].includes(a.name)||![p.bOld,p.bNew].includes(b.name))throw Error('別の操作で名前が変わっています。自動復旧せずDrive上で確認してください。');
  if(state.live){
    if(!a.parents?.includes(p.folder)||!b.parents?.includes(p.folder))throw Error('保存時のフォルダから画像が移動されています。Drive上で確認してください。');
    const files=await list(`'${escapeQuery(p.folder)}' in parents and trashed=false`);
    if(files.some(f=>f.id!==p.a&&f.id!==p.b&&[imageDate(p.aOld),imageDate(p.bOld)].includes(imageDate(f.name))))throw Error('復旧先の日付に別の画像があります。Drive上で確認してください。');
    if(a.name!==p.aOld||b.name!==p.bOld){
      if(a.name!==p.temp)await patchName(p.a,p.temp,a.name);
      if(b.name!==p.bOld)await patchName(p.b,p.bOld,b.name);
      await patchName(p.a,p.aOld,p.temp);
    }
  }
  applyPair(p,true);saveSwap(null);await loadFolder();render();status('入れ替え前の名前へ復旧しました。');
}
// 同じfile_idの日記履歴を全件削除。行番号は直前に読み直し、下から削除する。
function diaryDeleteRequests(rows,fileId,sheetId) {
  const requests=[];
  for(let i=rows.length-1;i>=0;i--)if(rows[i][1]===fileId)requests.push({deleteDimension:{range:{sheetId,dimension:'ROWS',startIndex:i+1,endIndex:i+2}}});
  return requests;
}
async function deleteDiary() {
  const file=current();if(!file)return;
  if(!confirm('この画像の日記を、過去の保存履歴も含めて削除します。\nGoogle接続中はスプレッドシートの該当行も削除します。\nこのアプリでは取り消せません。続けますか？'))return;
  if(state.live){
    await validateSheet();
    const metadata=await json(sheetURL('?fields=sheets(properties(sheetId,title))'));
    const sheetId=metadata.sheets.find(s=>s.properties.title==='Diary')?.properties.sheetId;
    if(sheetId===undefined)throw Error('Diaryシートがありません。');
    const range='/values/'+encodeURIComponent('Diary!A2:E');
    const first=(await json(sheetURL(range))).values||[];
    const second=(await json(sheetURL(range))).values||[];
    if(JSON.stringify(first)!==JSON.stringify(second))throw Error('別の操作で日記が更新されました。再読み込みしてやり直してください。');
    const requests=diaryDeleteRequests(second,file.id,sheetId);
    if(requests.length){
      try{await json(sheetURL(':batchUpdate'),{method:'POST',body:JSON.stringify({requests})});}
      catch(e){throw Error('削除結果を確認できませんでした。再読み込みして保存先を確認してください。 '+e.message);}
    }
    const remaining=(await json(sheetURL(range))).values||[];
    if(remaining.some(row=>row[1]===file.id))throw Error('別端末から日記が保存された可能性があります。再読み込みして確認してください。');
  }
  state.diary.delete(file.id);state.dirty=false;$('#diary').value='';$('#diaryStatus').textContent='削除済み';controls();
  status('この画像の日記と保存履歴を削除しました。画像とお気に入りは残しています。');
}
