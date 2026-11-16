# เพิ่มไฟล์ Swift ของเราเข้า target "App" ในโปรเจกต์ Xcode
require 'xcodeproj'
proj = Xcodeproj::Project.open('ios/App/App.xcodeproj')
target = proj.targets.find { |t| t.name == 'App' }
group = proj.main_group.children.find { |g| g.respond_to?(:path) && (g.path == 'App' || g.display_name == 'App') && g.isa == 'PBXGroup' }
%w[AstraViewController.swift VoiceEnginePlugin.swift Adpcm.swift].each do |f|
  next if group.files.any? { |x| x.path == f }
  ref = group.new_reference(f)
  target.add_file_references([ref])
  puts "added #{f}"
end
proj.save
