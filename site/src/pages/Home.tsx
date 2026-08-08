import { Hero } from "../components/Hero"
import { CallToAction } from "../components/home/CallToAction"
import { CodeShowcase } from "../components/home/CodeShowcase"
import { DockerfileSupport } from "../components/home/DockerfileSupport"
import { Features } from "../components/home/Features"
import { Guides } from "../components/home/Guides"
import { HowRunWorks } from "../components/home/HowRunWorks"
import { Install } from "../components/home/Install"
import { Limits } from "../components/home/Limits"
import { Packages } from "../components/home/Packages"
import { TheGap } from "../components/home/TheGap"

export const Home = () => (
  <>
    <Hero />
    <TheGap />
    <Install />
    <HowRunWorks />
    <CodeShowcase />
    <Features />
    <Guides />
    <DockerfileSupport />
    <Packages />
    <Limits />
    <CallToAction />
  </>
)
