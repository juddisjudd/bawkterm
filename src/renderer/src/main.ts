import { mount } from 'svelte'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import '@fontsource/ibm-plex-mono/700.css'
import '@xterm/xterm/css/xterm.css'
import './app.css'
import App from './App.svelte'

mount(App, { target: document.getElementById('app')! })
