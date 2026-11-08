import React from 'react'
import {createRoot} from 'react-dom/client'
import OceanFreightPage from '../src/pages/OceanFreightPage'
import type {User} from '../src/lib/types'
import '../src/styles.css'
document.body.classList.add('pi-console-theme')
createRoot(document.getElementById('root')!).render(<OceanFreightPage user={{id:'ocean-ui-qa-local',name:'验收员工',username:'qa-local',role:'employee'} as User}/>)
