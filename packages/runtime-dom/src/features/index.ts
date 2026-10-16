// Every feature at once: what `@brust/runtime-dom` (the full entry) loads. The browser build never uses this file;
// it imports exactly the features a route needs.
import './basics'
import './if'
import './for'
import './model'
import './html'
import './island'
import './collection'
