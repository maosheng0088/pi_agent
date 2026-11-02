import horizontal from '../assets/brand/dreamway-horizontal-generated.png'

/** Use the selected horizontal artwork; SVG viewports omit its blank margins. */
export default function CompanyLogo({variant='horizontal'}:{variant?:'horizontal'|'full'}){
 return <span className={`company-logo company-logo-${variant}`} role="img" aria-label="DREAMWAY 企业标志">
  <svg className="company-logo-lockup" viewBox="78 170 2016 380" aria-hidden="true" focusable="false"><image href={horizontal} width="2172" height="724"/></svg>
  {variant==='horizontal'&&<svg className="company-logo-mark" viewBox="78 170 410 380" aria-hidden="true" focusable="false"><image href={horizontal} width="2172" height="724"/></svg>}
 </span>
}
