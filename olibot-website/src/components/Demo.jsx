export default function Demo() {
  return (
    <section id="demo" className="pb-20">
      <div className="max-w-narrow mx-auto px-6">
        <div className="border border-border rounded-lg overflow-hidden bg-black aspect-video">
          <iframe
            src="https://www.youtube.com/embed/Jsdy11UG1LU"
            title="Oli Bot Demo"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="w-full h-full block"
          />
        </div>
      </div>
    </section>
  )
}
