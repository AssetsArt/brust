// F511: a 38-case switch, each case a different icon. Placed in the rows of a list that reads a store, `k` is reactive and
// every case becomes an arm of one reactive run: before F511 each arm nested the rest in both of its copies (2^38).
import { AppWindow, Bell, Braces, ChartLine, ChartPie, Cookie, CreditCard, Files, Gauge, Globe, History, Images, LayoutTemplate, Mail, MailOpen, MapPin, Megaphone, Menu, MousePointerClick, Newspaper, Package, Palette, PanelBottom, PanelLeft, PanelTop, Plug, Receipt, Search, ShoppingCart, SlidersHorizontal, Smartphone, Store, TicketPercent, Truck, User, Users, Wallet, Wrench } from 'lucide-react'

export function Icon({ k }: { k: string }) {
  switch (k) {
    case 'k0':
      return <AppWindow size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k1':
      return <Bell size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k2':
      return <Braces size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k3':
      return <ChartLine size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k4':
      return <ChartPie size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k5':
      return <Cookie size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k6':
      return <CreditCard size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k7':
      return <Files size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k8':
      return <Gauge size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k9':
      return <Globe size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k10':
      return <History size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k11':
      return <Images size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k12':
      return <LayoutTemplate size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k13':
      return <Mail size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k14':
      return <MailOpen size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k15':
      return <MapPin size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k16':
      return <Megaphone size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k17':
      return <Menu size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k18':
      return <MousePointerClick size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k19':
      return <Newspaper size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k20':
      return <Package size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k21':
      return <Palette size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k22':
      return <PanelBottom size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k23':
      return <PanelLeft size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k24':
      return <PanelTop size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k25':
      return <Plug size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k26':
      return <Receipt size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k27':
      return <Search size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k28':
      return <ShoppingCart size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k29':
      return <SlidersHorizontal size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k30':
      return <Smartphone size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k31':
      return <Store size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k32':
      return <TicketPercent size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k33':
      return <Truck size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k34':
      return <User size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k35':
      return <Users size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k36':
      return <Wallet size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    case 'k37':
      return <Wrench size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
    default:
      return null
  }
}
