import { fromRGBA } from './model/buffer.js';
import { histogram } from './model/processing.js';
import { Processor } from './services/processor.js';

const $=id=>document.getElementById(id), processor=new Processor();
const labels={niblack:'Ниблэк',bernsen:'Бернсен',sauvola:'Саувола',bradley:'Брэдли',median:'Медианный фильтр',minimum:'Минимальный фильтр',maximum:'Максимальный фильтр'};
const help={niblack:'Локальный порог: среднее плюс k стандартных отклонений. Типичное k = −0,2.',bernsen:'Локальный порог по минимуму и максимуму. C отсекает малоконтрастные окна.',sauvola:'Адаптивный порог по среднему и разбросу яркости. Типичные k = 0,34 и R = 128.',bradley:'Адаптивный порог ниже локального среднего на t процентов.',median:'Медиана окна удаляет одиночные светлые и тёмные импульсы.',minimum:'Минимум в окне подавляет светлые импульсы и расширяет тёмные детали.',maximum:'Максимум в окне подавляет тёмные импульсы и расширяет светлые детали.'};
const sampleHelp={shadows:'Сравните Сауволу и Ниблэка на неоднородном освещении: оцените фон и сохранность штрихов.',lowcontrast:'Сравните Ниблэка (k = −0,2) и Бернсена (C = 30 и 40): высокий C удаляет слабые штрихи.',saltpepper:'Выберите медианный фильтр с радиусом 1. Для бинаризации включите предварительную медиану.',details:'Сравните минимум и максимум с радиусом 1: первый расширяет тёмное, второй — светлое.'};
let source=null,result=null,resultName='',busy=false,loadId=0,runId=0;
function status(message) { $('status').textContent=message; }
function setBusy(value) {
  busy=value; $('run').disabled=value||!source; $('cancel').hidden=!value;
  $('settings').querySelectorAll('input,select').forEach(el=>{el.disabled=value||!!el.closest('[hidden]');});
  $('fileInput').disabled=value; $('loadSample').disabled=value; $('sample').disabled=value;
  $('save').disabled=value||!result;
}
function draw(canvas,buffer) {
  canvas.width=buffer.width; canvas.height=buffer.height;
  const ctx=canvas.getContext('2d'), image=ctx.createImageData(buffer.width,buffer.height);
  for(let i=0;i<buffer.data.length;i++) { const j=i*4,v=buffer.data[i]; image.data[j]=v; image.data[j+1]=v; image.data[j+2]=v; image.data[j+3]=255; }
  ctx.putImageData(image,0,0);
}
function drawHistogram(canvas,buffer) {
  const ctx=canvas.getContext('2d'), bins=histogram(buffer.data), max=Math.max(...bins,1);
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  for(let i=0;i<256;i++) { const h=bins[i]/max*80; ctx.fillRect(i*2,82-h,2,h); }
  ctx.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
  ctx.font='11px system-ui'; ctx.textAlign='left'; ctx.fillText('0 · чёрный',0,98); ctx.textAlign='right'; ctx.fillText('255 · белый',512,98);
}
function methodChanged() {
  const method=$('method').value;
  $('kGroup').hidden=!['niblack','sauvola'].includes(method); $('rGroup').hidden=method!=='sauvola';
  $('contrastGroup').hidden=method!=='bernsen'; $('tGroup').hidden=method!=='bradley';
  $('k').value=method==='niblack'?-.2:.34;
  $('methodHelp').textContent=help[method];
  $('settings').querySelectorAll('input[type=number]').forEach(el=>{el.disabled=!!el.closest('[hidden]');});
}
function updateSize() { const size=2*Number($('radius').value)+1; $('windowSize').value=`${size} × ${size}`; }
async function load(blob,name,note='') {
  const id=++loadId;
  setBusy(true); $('cancel').hidden=true;
  try {
    if(blob.size>40*1024*1024) throw new Error('Файл больше 40 МиБ. Выберите изображение меньшего размера.');
    status('Декодирование изображения…');
    const bitmap=await createImageBitmap(blob);
    if(id!==loadId) { bitmap.close(); return; }
    // Полноразмерная обработка без скрытого уменьшения; ограничение с учётом SAT и потоков.
    if(bitmap.width*bitmap.height>8_000_000) { bitmap.close(); throw new Error('Допускается до 8 мегапикселей. Уменьшите изображение перед загрузкой.'); }
    const canvas=document.createElement('canvas'); canvas.width=bitmap.width; canvas.height=bitmap.height;
    const ctx=canvas.getContext('2d',{willReadFrequently:true}); ctx.drawImage(bitmap,0,0); bitmap.close();
    source=fromRGBA(ctx.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height);
    result=null; $('after').width=0; $('after').height=0; $('histAfter').getContext('2d').clearRect(0,0,512,100);
    $('empty').hidden=false; $('resultInfo').textContent=''; $('progress').value=0;
    draw($('before'),source); drawHistogram($('histBefore'),source);
    $('sourceInfo').textContent=`${name} · ${source.width} × ${source.height}`;
    $('sampleHelp').textContent=note; setBusy(false); status('Изображение готово. Настройте метод и нажмите «Обработать».');
  } catch(error) { if(id===loadId) { status(`Не удалось открыть: ${error.message}`); setBusy(false); } }
}
async function loadSample() {
  const name=$('sample').value;
  setBusy(true); $('cancel').hidden=true;
  try { const response=await fetch(`samples/${name}.png`); if(!response.ok) throw new Error('Тестовый файл недоступен'); await load(await response.blob(),$('sample').selectedOptions[0].textContent,sampleHelp[name]); }
  catch(error) { status(error.message); setBusy(false); }
}
$('settings').addEventListener('submit',async event=>{
  event.preventDefault(); if(!source||busy) return;
  const id=++runId, start=performance.now();
  const method=$('method').value;
  const o={method,radius:Number($('radius').value),border:$('border').value};
  if(['niblack','sauvola'].includes(method)) o.k=Number($('k').value);
  if(method==='sauvola') o.r=Number($('r').value);
  if(method==='bernsen') o.contrast=Number($('contrast').value);
  if(method==='bradley') o.t=Number($('t').value);
  const threads=Number($('threads').value),denoise=$('denoise').checked;
  setBusy(true); $('progress').value=0; status('Обработка…');
  try {
    let input=source;
    if(denoise) input=await processor.run(input,{method:'median',radius:1,border:o.border},threads,v=>{$('progress').value=v*.4;});
    result=await processor.run(input,o,threads,v=>{$('progress').value=denoise?.4+v*.6:v;});
    if(id!==runId) return;
    draw($('after'),result); drawHistogram($('histAfter'),result); $('empty').hidden=true;
    resultName=`lab3-${o.method}-${o.radius}-${o.border}.png`;
    const time=(performance.now()-start).toFixed(1);
    const black=result.data.reduce((n,v)=>n+(v===0),0)/result.data.length*100;
    $('resultInfo').textContent=`${labels[o.method]} · окно ${2*o.radius+1}×${2*o.radius+1} · ${o.border} · потоков: ${threads}${denoise?' · медиана 3×3':''} · ${time} мс · чёрных пикселей: ${black.toFixed(1)}%`;
    $('progress').value=1; status('Готово. Результат можно сохранить в PNG.');
  } catch(error) { if(id===runId) status(error.name==='AbortError'?'Обработка отменена.':`Ошибка: ${error.message}`); }
  finally { if(id===runId) setBusy(false); }
});
$('cancel').onclick=()=>{processor.cancel();};
$('save').onclick=()=>{
  $('after').toBlob(blob=>{if(!blob)return; const url=URL.createObjectURL(blob),a=document.createElement('a'); a.href=url; a.download=resultName; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);},'image/png');
};
$('method').onchange=methodChanged; $('radius').oninput=updateSize;
$('loadSample').onclick=loadSample;
$('fileInput').onchange=event=>{const file=event.target.files[0];if(file)load(file,file.name);event.target.value='';};
document.addEventListener('dragover',event=>{event.preventDefault(); if(!busy)$('dropZone').classList.add('dragover');});
document.addEventListener('dragleave',event=>{if(!event.relatedTarget)$('dropZone').classList.remove('dragover');});
document.addEventListener('drop',event=>{event.preventDefault();$('dropZone').classList.remove('dragover');if(!busy&&event.dataTransfer.files[0])load(event.dataTransfer.files[0],event.dataTransfer.files[0].name);});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(source)drawHistogram($('histBefore'),source);if(result)drawHistogram($('histAfter'),result);});
methodChanged(); updateSize(); loadSample();
