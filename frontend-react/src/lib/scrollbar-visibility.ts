/** Also reveal scrollbars for wheel, touch and keyboard scrolling outside hover. */
export function installScrollbarVisibility(){
 const timers=new Map<HTMLElement,ReturnType<typeof setTimeout>>()
 const scroll=(event:Event)=>{
  const target=event.target===document?document.scrollingElement:event.target
  if(!(target instanceof HTMLElement)||target.scrollHeight<=target.clientHeight&&target.scrollWidth<=target.clientWidth)return
  if(!timers.has(target))target.setAttribute('data-scroll-active','')
  else clearTimeout(timers.get(target))
  timers.set(target,setTimeout(()=>{target.removeAttribute('data-scroll-active');timers.delete(target)},900))
 }
 document.addEventListener('scroll',scroll,{capture:true,passive:true})
 return ()=>{document.removeEventListener('scroll',scroll,true);for(const [element,timer]of timers){clearTimeout(timer);element.removeAttribute('data-scroll-active')}timers.clear()}
}
