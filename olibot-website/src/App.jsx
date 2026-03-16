import Nav from './components/Nav'
import Hero from './components/Hero'
import Demo from './components/Demo'
import Features from './components/Features'
import HowItWorks from './components/HowItWorks'
import UseCases from './components/UseCases'
import Pricing from './components/Pricing'
import Register from './components/Register'
import Footer from './components/Footer'

function App() {
  return (
    <div className="min-h-screen bg-bg">
      <Nav />
      <Hero />
      <Demo />
      <Features />
      <HowItWorks />
      <UseCases />
      <Pricing />
      <Register />
      <Footer />
    </div>
  )
}

export default App
