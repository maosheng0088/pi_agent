from pathlib import Path
import xml.etree.ElementTree as E,json
r=Path('D:/code/pi-web/.tools/android')
root=E.parse(r/'repository.xml').getroot()
selected=[]
for p in root.findall('remotePackage'):
 if p.attrib['path'] not in ['build-tools;35.0.0','platforms;android-35','platform-tools']:
  continue
 for a in p.findall('./archives/archive'):
  host=a.findtext('host-os')
  if host not in [None,'windows']:continue
  complete=a.find('complete')
  if p.attrib['path']=='platforms;android-35' and complete.findtext('url')!='platform-35-ext15_r01.zip':continue
  selected.append({'package':p.attrib['path'],'url':'https://dl.google.com/android/repository/'+complete.findtext('url'),'size':int(complete.findtext('size')),'checksum':complete.findtext('checksum'),'checksumType':complete.find('checksum').attrib.get('type','sha1')})
(r/'sdk.json').write_text(json.dumps(selected,indent=2),encoding='utf-8')
print(json.dumps(selected,indent=2))
