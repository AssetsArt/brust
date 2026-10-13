// Reached only through a dynamic import(): its CSS is still linked for the route (review N4).
import './lazy.css'
import styles from './Lazy.module.css'

export default function LazyPanel() {
  return <div className={styles.panel}>panel</div>
}
